import { randomUUID } from "node:crypto";
import { calendarDateAt } from "@/i18n/format";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { propertyFinanceAuthorityChecks } from "@/platform/authz/property-finance-resource";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { PerformanceReportRepository } from "../infrastructure/performance-report-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { accountantExportPolicyKey, accountantExportPolicySchema, type AccountantExportPolicy } from "../domain/accountant-export-policy";
import type { AccountantExportFormat } from "../domain/accountant-export";
import { PerformanceReportAccessError, PerformanceReportUnavailableError, performanceReportFilters, propertyReportTotals } from "../domain/performance-report";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type ExportAdmission<T> = {
  format: AccountantExportFormat;
  render: (report: PropertyPerformanceReport, policy: { id: string; version: number; capacity: number }) => T | Promise<T>;
};

function loadPropertyReport(actor: FinanceActorContext, raw: unknown, deps: Deps): Promise<PropertyPerformanceReport>;
function loadPropertyReport<T>(actor: FinanceActorContext, raw: unknown, deps: Deps, output: ExportAdmission<T>): Promise<T>;
async function loadPropertyReport<T>(actor: FinanceActorContext, raw: unknown, deps: Deps, output?: ExportAdmission<T>) {
  const input = performanceReportFilters.parse(raw);
  if (!input.propertyId) throw new PerformanceReportAccessError();
  const propertyId = input.propertyId;
  const action = output ? "export" : "view";
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new PerformanceReportRepository(tx, actor.organizationId);
    const clock = () => new FinanceRepository(tx, actor.organizationId).clock();
    const property = await repository.property(propertyId);
    if (!property) throw new PerformanceReportAccessError();
    const organizationId = actor.organizationId;
    const resource = { type: "report", id: propertyId, propertyId, organizationId, city: property.cityId, region: property.regionId, dataClass: "financial" as const };
    const checks: CurrentAuthorityCheck[] = [
      { action: "view" as const, resource },
      { action, resource },
      ...propertyFinanceAuthorityChecks(resource, action),
      { action: "view" as const, resource: { ...resource, type: "reservation", dataClass: "operational" as const }, unconditional: true }
    ];
    const now = await clock();
    const recheck = (at: Date) => recheckFinanceAuthorization(actor, tx, at, checks, new PerformanceReportAccessError());
    await recheck(now);
    const timezone = property.timezone;
    const settings = await repository.settings();
    const currency = input.currency ?? settings.baseCurrency;
    if (!timezone || !settings.currencies.some(row => row.code === currency)) throw new PerformanceReportUnavailableError();
    const defaults = await repository.defaults(now, timezone);
    const today = calendarDateAt(now, timezone);
    const fromOn = input.fromOn ?? defaults.fromOn;
    const toOn = input.toOn ?? today;
    if (toOn < fromOn || toOn > today) throw new PerformanceReportUnavailableError();
    const range = await repository.range(fromOn, toOn, timezone);
    const policyRepo = new ConfigRuleRepository(tx, organizationId);
    const resolvePolicy = (asOf: Date) => policyRepo.resolve({ key: accountantExportPolicyKey,
      scopes: [{ scopeType: "organization", scopeId: null }], asOf });
    const rule = await resolvePolicy(now);
    const parsed = accountantExportPolicySchema.safeParse(rule?.value);
    const exportPolicy: AccountantExportPolicy | null = parsed.success ? parsed.data : null;
    if (output) {
      if (!rule || !exportPolicy?.formats.includes(output.format)) throw new PerformanceReportUnavailableError();
      const limit = await consumeRateLimit(tx, organizationId, { key: "finance.accountant_exports:" + actor.actorId,
        limit: exportPolicy.rate_limit.requests, windowSeconds: exportPolicy.rate_limit.window_seconds, now });
      if (!limit.allowed) throw new PerformanceReportUnavailableError();
    }
    const capture = async () => {
      const [postings, nights] = await Promise.all([
        repository.propertyPostings({ propertyId, currency, ...range }), repository.propertyNights(propertyId, fromOn, toOn)
      ]);
      if (!nights) throw new PerformanceReportUnavailableError();
      return { postings, nights };
    };
    const source = await capture();
    const sourceFingerprint = commandFingerprint({ propertyId, fromOn, toOn, timezone, currency, source });
    const report = { ...propertyReportTotals(currency, source.postings, source.nights), propertyId, propertyName: property.name,
      fromOn, toOn, today, timezone, currency, currencies: settings.currencies.map(row => row.code), sourceFingerprint,
      generatedAt: now.toISOString(), formats: exportPolicy?.formats ?? [] };

    const result = output && rule && exportPolicy
      ? await output.render(report, { id: rule.id, version: rule.version, capacity: exportPolicy.capacity[output.format] })
      : report;
    if (output) {
      const [current, currentPolicy, original] = await Promise.all([repository.property(propertyId), resolvePolicy(await clock()), capture()]);
      if (current?.timezone !== timezone || current.name !== property.name || commandFingerprint(currentPolicy) !== commandFingerprint(rule)
        || commandFingerprint(original) !== commandFingerprint(source)) throw new PerformanceReportUnavailableError();
    }
    await recheck(await clock());
    await writeAuditEvent(tx, { organizationId, actorId: actor.actorId, action: "finance.property_report." + (output ? "exported" : "viewed"),
      resourceType: "report", resourceId: propertyId, propertyScopeId: propertyId, occurredAt: now, requestId: deps.requestId ?? randomUUID(),
      reason: "Read original property postings and reservation calendar", after: { fromOn, toOn, timezone, currency, sourceFingerprint, format: output?.format ?? null } });
    await recheck(await clock());
    return result;
  });
}

export type PropertyPerformanceReport = ReturnType<typeof propertyReportTotals> & {
  propertyId: string; propertyName: string; fromOn: string; toOn: string; today: string; timezone: string; currency: string;
  currencies: string[]; sourceFingerprint: string; generatedAt: string; formats: AccountantExportFormat[];
};

export async function getPropertyPerformanceReport(actor: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  return await loadPropertyReport(actor, raw, deps);
}

export async function exportPropertyPerformanceReport<T>(actor: FinanceActorContext, raw: unknown, output: ExportAdmission<T>, deps: Deps = {}) {
  return loadPropertyReport(actor, raw, deps, output);
}
