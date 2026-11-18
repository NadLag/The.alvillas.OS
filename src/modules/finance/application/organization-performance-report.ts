import { randomUUID } from "node:crypto";
import { calendarDateAt } from "@/i18n/format";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { LedgerCalendarConfigurationError } from "@/platform/ledger/ledger-calendar-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { PerformanceReportRepository } from "../infrastructure/performance-report-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { accountantExportPolicyKey, accountantExportPolicySchema } from "../domain/accountant-export-policy";
import type { AccountantExportFormat } from "../domain/accountant-export";
import { PerformanceReportAccessError, PerformanceReportUnavailableError, performanceReportFilters } from "../domain/performance-report";

export type PerformanceReportDeps = { db?: TenantTransactionRunner; requestId?: string };
export type OrganizationReportPeriod = {
  fromOn: string; toOn: string; today: string; timezone: string; currency: string; currencies: string[];
  sourceFingerprint: string; generatedAt: string; formats: AccountantExportFormat[];
};
export type PerformanceExport<T> = {
  format: AccountantExportFormat;
  render: (report: T, policy: { id: string; version: number; capacity: number }) => Uint8Array | Promise<Uint8Array>;
};
type ReportQuery = { currency: string; timezone: string; fromOn: string; toOn: string; startsAt: Date; endsAt: Date };
export type OrganizationReportSource<S, T extends object> = {
  auditResource: "company_report" | "team_report";
  operationalSources: readonly string[];
  financialSources: readonly string[];
  capture: (repository: PerformanceReportRepository, query: ReportQuery) => Promise<S>;
  summarize: (currency: string, source: S) => T;
};

export function readOrganizationPerformance<S, T extends object>(actor: FinanceActorContext, raw: unknown, descriptor: OrganizationReportSource<S, T>,
  deps: PerformanceReportDeps): Promise<T & OrganizationReportPeriod>;
export function readOrganizationPerformance<S, T extends object>(actor: FinanceActorContext, raw: unknown, descriptor: OrganizationReportSource<S, T>,
  deps: PerformanceReportDeps, output: PerformanceExport<T & OrganizationReportPeriod>): Promise<Uint8Array>;
export async function readOrganizationPerformance<S, T extends object>(actor: FinanceActorContext, raw: unknown, descriptor: OrganizationReportSource<S, T>,
  deps: PerformanceReportDeps, output?: PerformanceExport<T & OrganizationReportPeriod>) {
  const input = performanceReportFilters.parse(raw);
  if (input.propertyId) throw new PerformanceReportAccessError();
  const organizationId = actor.organizationId;
  const resource = (type: string, dataClass: "operational" | "financial") => ({ type, organizationId, dataClass });
  const checks: CurrentAuthorityCheck[] = [
    ...descriptor.operationalSources.map(type => ({ action: "view" as const, resource: resource(type, "operational"), organizationOnly: true })),
    ...["report", ...descriptor.financialSources].flatMap(type => [
      { action: "view" as const, resource: resource(type, "financial"), organizationOnly: true },
      ...(output ? [{ action: "export" as const, resource: resource(type, "financial"), organizationOnly: true }] : [])
    ])
  ];
  return withTenant(deps.db ?? prisma, organizationId, async tx => {
    const clock = () => new FinanceRepository(tx, organizationId).clock();
    const recheck = (at: Date) => recheckFinanceAuthorization(actor, tx, at, checks, new PerformanceReportAccessError());
    await recheck(await clock());
    const repository = new PerformanceReportRepository(tx, organizationId);
    const settings = await repository.configuration().catch((error: unknown) => {
      if (error instanceof LedgerCalendarConfigurationError) throw new PerformanceReportUnavailableError();
      throw error;
    });
    const { timezone, now } = settings;
    const currency = input.currency ?? settings.baseCurrency;
    if (!settings.currencies.some(row => row.code === currency)) throw new PerformanceReportUnavailableError();
    const today = calendarDateAt(now, timezone);
    const fromOn = input.fromOn ?? (await repository.defaults(now, timezone)).fromOn;
    const toOn = input.toOn ?? today;
    if (toOn < fromOn || toOn > today) throw new PerformanceReportUnavailableError();
    const range = await repository.range(fromOn, toOn, timezone);
    const policyRepo = new ConfigRuleRepository(tx, organizationId);
    const resolvePolicy = (asOf: Date) => policyRepo.resolve({ key: accountantExportPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf });
    const rule = await resolvePolicy(now);
    const parsed = accountantExportPolicySchema.safeParse(rule?.value);
    const exportPolicy = parsed.success ? parsed.data : null;
    if (output) {
      if (!rule || !exportPolicy?.formats.includes(output.format)) throw new PerformanceReportUnavailableError();
      const limit = await consumeRateLimit(tx, organizationId, { key: "finance.accountant_exports:" + actor.actorId,
        limit: exportPolicy.rate_limit.requests, windowSeconds: exportPolicy.rate_limit.window_seconds, now });
      if (!limit.allowed) throw new PerformanceReportUnavailableError();
    }
    const capture = () => descriptor.capture(repository, { ...range, currency, timezone, fromOn, toOn });
    const source = await capture();
    const sourceFingerprint = commandFingerprint({ fromOn, toOn, timezone, currency, source });
    const report = { ...descriptor.summarize(currency, source), fromOn, toOn, today, timezone, currency,
      currencies: settings.currencies.map(row => row.code), sourceFingerprint, generatedAt: now.toISOString(),
      formats: ["report", ...descriptor.financialSources].every(type => authorizeOrganizationSource(actor.authContext, "export", resource(type, "financial"), now))
        ? exportPolicy?.formats ?? [] : [] };
    const result = output && rule && exportPolicy
      ? await output.render(report, { id: rule.id, version: rule.version, capacity: exportPolicy.capacity[output.format] })
      : report;
    if (output) {
      const [currentSettings, currentPolicy, currentSource] = await Promise.all([repository.configuration(), resolvePolicy(await clock()), capture()]);
      if (currentSettings.policyId !== settings.policyId || currentSettings.timezone !== timezone
        || commandFingerprint(currentPolicy) !== commandFingerprint(rule) || commandFingerprint(currentSource) !== commandFingerprint(source)) {
        throw new PerformanceReportUnavailableError();
      }
    }
    await recheck(await clock());
    await writeAuditEvent(tx, { organizationId, actorId: actor.actorId, action: "finance." + descriptor.auditResource + "." + (output ? "exported" : "viewed"),
      resourceType: "report", resourceId: organizationId, occurredAt: now, requestId: deps.requestId ?? randomUUID(),
      reason: "Read the original sealed financial and operational sources",
      after: { fromOn, toOn, timezone, currency, sourceFingerprint, format: output?.format ?? null } });
    await recheck(await clock());
    return result;
  });
}
