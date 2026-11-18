import { randomUUID } from "node:crypto";
import { calendarDateAt } from "@/i18n/format";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { LedgerCalendarConfigurationError } from "@/platform/ledger/ledger-calendar-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { dueReportPeriod, reportSchedulesKey, reportSchedulesPolicy, type ScheduledReport } from "../domain/scheduled-report";
import { PerformanceReportAccessError, PerformanceReportUnavailableError } from "../domain/performance-report";
import { PerformanceReportRepository } from "../infrastructure/performance-report-repository";
import { ScheduledReportRepository } from "../infrastructure/scheduled-report-repository";
import { getCompanyPerformanceReport } from "./company-performance-report";
import { getTeamPerformanceReport } from "./team-performance-report";
import { getPropertyPerformanceReport } from "./property-performance-report";
import { getInventoryPerformanceReport } from "./inventory-performance-report";
import { getKpiReport } from "./kpi-report";

const sources = { PROPERTY: getPropertyPerformanceReport, COMPANY: getCompanyPerformanceReport, TEAM: getTeamPerformanceReport,
  INVENTORY: getInventoryPerformanceReport, KPI: getKpiReport };
const organizationScope = { scopeType: "organization", scopeId: null } as const;

export async function tickScheduledReports(organizationId: string, deps: { db?: TenantTransactionRunner; observedAt?: Date } = {}) {
  const db = deps.db ?? prisma;
  const capture = await withTenant(db, organizationId, async tx => {
    const repository = new PerformanceReportRepository(tx, organizationId);
    const settings = await repository.configuration().catch((error: unknown) => {
      if (error instanceof LedgerCalendarConfigurationError) return null;
      throw error;
    });
    if (!settings) return null;
    const now = deps.observedAt ?? settings.now;
    const rule = await new ConfigRuleRepository(tx, organizationId).resolve({ key: reportSchedulesKey, scopes: [organizationScope], asOf: now });
    if (!rule?.createdBy) return null;
    const schedules = reportSchedulesPolicy.parse(rule.value).schedules;
    return { now, timezone: settings.timezone, rule, schedules, authorId: rule.createdBy };
  });
  if (!capture) return { scheduled: 0, blocked: 0 };
  let scheduled = 0, blocked = 0;
  for (const schedule of capture.schedules) {
    for (const recipientId of schedule.recipients) {
      const status = await deliver(schedule, recipientId).catch((error: unknown) => {
        if (error instanceof PerformanceReportAccessError || error instanceof PerformanceReportUnavailableError) return "blocked";
        throw error;
      });
      if (status === "scheduled") scheduled++;
      if (status === "blocked") blocked++;
    }
  }
  return { scheduled, blocked };

  async function deliver(schedule: ScheduledReport, recipientId: string) {
    if (!capture) return "ignored";
    return withTenant(db, organizationId, async tx => {
      const repository = new PerformanceReportRepository(tx, organizationId);
      const property = schedule.propertyId ? await repository.property(schedule.propertyId) : null;
      if (schedule.propertyId && !property) return "blocked";
      const timezone = property?.timezone ?? capture.timezone;
      const period = dueReportPeriod(schedule, capture.now, timezone);
      if (!period || period.scheduledOn < calendarDateAt(capture.rule.effectiveFrom, timezone)) return "ignored";
      const runs = new ScheduledReportRepository(tx, organizationId);
      const occurrence = { scheduleId: schedule.id, recipientId, scheduledOn: period.scheduledOn };
      await runs.lock(occurrence);
      if (await runs.exists(occurrence)) return "ignored";
      const rules = new ConfigRuleRepository(tx, organizationId);
      const validateRule = async () => {
        const active = await rules.resolve({ key: reportSchedulesKey, scopes: [organizationScope], asOf: capture.now });
        const author = await authContextForAccountInTransaction(tx, organizationId, capture.authorId);
        if (active?.id !== capture.rule.id || !authorizeOrganizationSource(author, "configure",
          { type: "config_rule", id: capture.rule.id, organizationId }, capture.now)) throw new PerformanceReportAccessError();
      };
      await validateRule();
      const context = await authContextForAccountInTransaction(tx, organizationId, recipientId);
      const actor = { organizationId, actorId: recipientId, authContext: context };
      const transaction: TenantTransactionRunner = { $transaction: work => work(tx) };
      const report = await sources[schedule.kind](actor, { propertyId: schedule.propertyId, currency: schedule.currency,
        ...schedule.filters, fromOn: period.fromOn, toOn: period.toOn }, { db: transaction });
      const id = await runs.append({ ...occurrence, ruleId: capture.rule.id, propertyId: property?.id ?? null,
        kind: schedule.kind, fromOn: report.fromOn, toOn: report.toOn, currency: report.currency, filters: schedule.filters ?? {},
        channels: schedule.channels, fingerprint: report.sourceFingerprint, generatedAt: new Date(report.generatedAt) });
      if (!id) return "ignored";
      const notifications = new NotificationRepository(tx, organizationId);
      await notifications.publishMany([{ input: { kind: "report_ready", recipientId, targetId: id }, key: "report-ready:" + id, occurredAt: capture.now }]);
      await writeAuditEvent(tx, { organizationId, actorId: null, resourceType: "report", resourceId: id, propertyScopeId: property?.id,
        action: "finance.report.scheduled", requestId: randomUUID(), occurredAt: capture.now, reason: "Published a configured report to its authorized recipient",
        after: { scheduleId: schedule.id, ruleId: capture.rule.id, recipientId, ...period, currency: report.currency, sourceFingerprint: report.sourceFingerprint } });
      await validateRule();
      return "scheduled";
    });
  }
}
