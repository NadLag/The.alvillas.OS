import { randomUUID } from "node:crypto";
import { calendarDateAt } from "@/i18n/format";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { propertyFinanceFinancialSources } from "@/platform/authz/property-finance-resource";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { LedgerCalendarConfigurationError } from "@/platform/ledger/ledger-calendar-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { PerformanceReportRepository } from "../infrastructure/performance-report-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { accountantExportPolicyKey, accountantExportPolicySchema } from "../domain/accountant-export-policy";
import type { AccountantExportFormat } from "../domain/accountant-export";
import { companyReportTotals, PerformanceReportAccessError, PerformanceReportUnavailableError, performanceReportFilters } from "../domain/performance-report";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type ExportAdmission<T> = {
  format: AccountantExportFormat;
  render: (report: CompanyPerformanceReport, policy: { id: string; version: number; capacity: number }) => T | Promise<T>;
};

function readCompanyReport(actor: FinanceActorContext, raw: unknown, deps: Deps): Promise<CompanyPerformanceReport>;
function readCompanyReport<T>(actor: FinanceActorContext, raw: unknown, deps: Deps, output: ExportAdmission<T>): Promise<T>;
async function readCompanyReport<T>(actor: FinanceActorContext, raw: unknown, deps: Deps, output?: ExportAdmission<T>) {
  const input = performanceReportFilters.parse(raw);
  if (input.propertyId) throw new PerformanceReportAccessError();
  const organizationId = actor.organizationId;
  const resource = (type: string, dataClass: "operational" | "financial") => ({ type, organizationId, dataClass });
  const checks: CurrentAuthorityCheck[] = [
    ...["property", "reservation"].map(type => ({ action: "view" as const, resource: resource(type, "operational"), organizationOnly: true })),
    ...["report", ...propertyFinanceFinancialSources].flatMap(type => [
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
    const capture = async () => {
      const [postings, portfolio] = await Promise.all([
        repository.companyPostings({ currency, ...range }), repository.portfolioNights(fromOn, toOn)
      ]);
      return { postings, portfolio };
    };
    const source = await capture();
    const sourceFingerprint = commandFingerprint({ fromOn, toOn, timezone, currency, source });
    const report = { ...companyReportTotals(currency, source.postings, source.portfolio), fromOn, toOn, today, timezone, currency,
      currencies: settings.currencies.map(row => row.code), sourceFingerprint, generatedAt: now.toISOString(),
      formats: ["report", ...propertyFinanceFinancialSources].every(type => authorizeOrganizationSource(actor.authContext, "export", resource(type, "financial"), now))
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
    await writeAuditEvent(tx, { organizationId, actorId: actor.actorId, action: "finance.company_report." + (output ? "exported" : "viewed"),
      resourceType: "report", resourceId: organizationId, occurredAt: now, requestId: deps.requestId ?? randomUUID(),
      reason: "Read original company postings and portfolio reservation calendars",
      after: { fromOn, toOn, timezone, currency, sourceFingerprint, format: output?.format ?? null, properties: source.portfolio.length } });
    await recheck(await clock());
    return result;
  });
}

export type CompanyPerformanceReport = ReturnType<typeof companyReportTotals> & {
  fromOn: string; toOn: string; today: string; timezone: string; currency: string; currencies: string[];
  sourceFingerprint: string; generatedAt: string; formats: AccountantExportFormat[];
};

export function getCompanyPerformanceReport(actor: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  return readCompanyReport(actor, raw, deps);
}
export function exportCompanyPerformanceReport<T>(actor: FinanceActorContext, raw: unknown, output: ExportAdmission<T>, deps: Deps = {}) {
  return readCompanyReport(actor, raw, deps, output);
}
