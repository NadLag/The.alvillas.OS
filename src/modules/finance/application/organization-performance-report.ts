import { randomUUID } from "node:crypto";
import { calendarDateAt } from "@/i18n/format";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorizeOrganizationSource, authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
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
  propertyId: string | null; propertyName: string | null;
  properties: { id: string; name: string }[]; portfolioAvailable: boolean;
  sourceFingerprint: string; generatedAt: string; formats: AccountantExportFormat[];
};
export type PerformanceExport<T> = {
  format: AccountantExportFormat;
  render: (report: T, policy: { id: string; version: number; capacity: number }) => Uint8Array | Promise<Uint8Array>;
};
export type ReportQuery = { propertyId: string | null; currency: string; timezone: string; fromOn: string; toOn: string; startsAt: Date; endsAt: Date };
export type OrganizationReportSource<S, T extends object> = {
  auditResource: "company_report" | "team_report" | "inventory_report" | "kpi_report";
  allowProperty?: boolean;
  dimensions?: Record<string, string>;
  resolveDates?: (today: string) => { fromOn: string; toOn: string };
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
  if (input.propertyId && !descriptor.allowProperty) throw new PerformanceReportAccessError();
  const organizationId = actor.organizationId;
  const resource = (type: string, dataClass: "operational" | "financial") => ({ type, organizationId, dataClass });
  return withTenant(deps.db ?? prisma, organizationId, async tx => {
    const repository = new PerformanceReportRepository(tx, organizationId);
    const property = input.propertyId ? await repository.property(input.propertyId) : null;
    if (input.propertyId && !property) throw new PerformanceReportAccessError();
    const propertyResource = (row: { id: string; cityId: string | null; regionId: string | null }) =>
      ({ id: row.id, propertyId: row.id, city: row.cityId, region: row.regionId, organizationId });
    const reportResource = { ...resource("report", "financial"), ...(property ? propertyResource(property) : {}) };
    const checks: CurrentAuthorityCheck[] = [
      ...descriptor.operationalSources.map(type => ({ action: "view" as const, resource: resource(type, "operational"), organizationOnly: true })),
      { action: "view", resource: reportResource, organizationOnly: !property, unconditional: true },
      ...(property ? [{ action: "view" as const, resource: { ...propertyResource(property), type: "property", dataClass: "operational" as const }, unconditional: true }] : []),
      ...(output ? [{ action: "export" as const, resource: reportResource, organizationOnly: !property, unconditional: true }] : []),
      ...descriptor.financialSources.flatMap(type => [
        { action: "view" as const, resource: resource(type, "financial"), organizationOnly: true },
        ...(output ? [{ action: "export" as const, resource: resource(type, "financial"), organizationOnly: true }] : [])
      ])
    ];
    const clock = () => new FinanceRepository(tx, organizationId).clock();
    const recheck = (at: Date) => recheckFinanceAuthorization(actor, tx, at, checks, new PerformanceReportAccessError());
    await recheck(await clock());
    const settings = await repository.configuration().catch((error: unknown) => {
      if (error instanceof LedgerCalendarConfigurationError) throw new PerformanceReportUnavailableError();
      throw error;
    });
    const { now } = settings;
    const timezone = property?.timezone ?? settings.timezone;
    const currency = input.currency ?? settings.baseCurrency;
    if (!settings.currencies.some(row => row.code === currency)) throw new PerformanceReportUnavailableError();
    const today = calendarDateAt(now, timezone);
    const dates = descriptor.resolveDates?.(today);
    const fromOn = dates?.fromOn ?? input.fromOn ?? (await repository.defaults(now, timezone)).fromOn;
    const toOn = dates?.toOn ?? input.toOn ?? today;
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
    const propertyId = property?.id ?? null;
    const capture = () => descriptor.capture(repository, { ...range, propertyId, currency, timezone, fromOn, toOn });
    const source = await capture();
    const sourceFingerprint = commandFingerprint({ propertyId, fromOn, toOn, timezone, currency, dimensions: descriptor.dimensions ?? {}, source });
    const properties = descriptor.allowProperty && !output ? await repository.reportProperties() : [];
    const currentAuthority = properties.length ? await authContextForAccountInTransaction(tx, organizationId, actor.actorId) : actor.authContext;
    const visibleProperties = properties.filter(row => [actor.authContext, currentAuthority].every(context =>
      authorizeUnconditionalSource(context, "view", { ...propertyResource(row), type: "property", dataClass: "operational" }, now) &&
      authorizeUnconditionalSource(context, "view", { ...reportResource, ...propertyResource(row) }, now)));
    const report = { ...descriptor.summarize(currency, source), propertyId, propertyName: property?.name ?? null,
      portfolioAvailable: [actor.authContext, currentAuthority].every(context => authorizeOrganizationSource(context, "view", resource("report", "financial"), now)),
      properties: visibleProperties.map(({ id, name }) => ({ id, name })), fromOn, toOn, today, timezone, currency,
      currencies: settings.currencies.map(row => row.code), sourceFingerprint, generatedAt: now.toISOString(),
      formats: authorizeUnconditionalSource(actor.authContext, "export", reportResource, now, !property) &&
        descriptor.financialSources.every(type => authorizeOrganizationSource(actor.authContext, "export", resource(type, "financial"), now))
        ? exportPolicy?.formats ?? [] : [] };
    const result = output && rule && exportPolicy
      ? await output.render(report, { id: rule.id, version: rule.version, capacity: exportPolicy.capacity[output.format] })
      : report;
    if (output) {
      const [currentSettings, currentPolicy, currentSource, currentProperty] = await Promise.all([
        repository.configuration(), resolvePolicy(await clock()), capture(), propertyId ? repository.property(propertyId) : null
      ]);
      if (currentSettings.policyId !== settings.policyId || currentSettings.timezone !== settings.timezone
        || commandFingerprint(currentProperty) !== commandFingerprint(property)
        || commandFingerprint(currentPolicy) !== commandFingerprint(rule) || commandFingerprint(currentSource) !== commandFingerprint(source)) {
        throw new PerformanceReportUnavailableError();
      }
    }
    await recheck(await clock());
    await writeAuditEvent(tx, { organizationId, actorId: actor.actorId, action: "finance." + descriptor.auditResource + "." + (output ? "exported" : "viewed"),
      resourceType: "report", resourceId: propertyId ?? organizationId, propertyScopeId: propertyId, occurredAt: now, requestId: deps.requestId ?? randomUUID(),
      reason: "Read the original sealed financial and operational sources",
      after: { fromOn, toOn, timezone, currency, dimensions: descriptor.dimensions ?? {}, sourceFingerprint, format: output?.format ?? null } });
    await recheck(await clock());
    return result;
  });
}
