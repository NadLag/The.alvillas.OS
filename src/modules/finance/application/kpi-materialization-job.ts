import { calendarDateAt } from "@/i18n/format";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { LedgerCalendarConfigurationError } from "@/platform/ledger/ledger-calendar-repository";
import { kpiRefreshKey, kpiRefreshPolicy, reportCalendarBounds } from "../domain/kpi-materialization";
import { KpiMaterializationRepository } from "../infrastructure/kpi-materialization-repository";
import { PerformanceReportRepository } from "../infrastructure/performance-report-repository";

export async function refreshKpiCalendar(organizationId: string, db: TenantTransactionRunner = prisma) {
  return withTenant(db, organizationId, async tx => {
    const rules = new ConfigRuleRepository(tx, organizationId);
    const source = new PerformanceReportRepository(tx, organizationId);
    const settings = await source.configuration().catch((error: unknown) => {
      if (error instanceof LedgerCalendarConfigurationError) return null;
      throw error;
    });
    if (!settings) return 0;
    const { now, timezone } = settings;
    const rule = await rules.resolve({ key: kpiRefreshKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
    if (!rule) return 0;
    const policy = kpiRefreshPolicy.parse(rule.value);
    const calendar = new KpiMaterializationRepository(tx, organizationId);
    const sourceRevision = await calendar.revision();
    const today = calendarDateAt(now, timezone);
    const minimum = new Date(now.getTime() - policy.refresh_minutes * 60_000);
    let refreshed = 0;
    for (const key of policy.periods) {
      const range = reportCalendarBounds(key, today);
      const input = { ...range, key, ruleId: rule.id, timezone, sourceRevision, observedAt: now };
      if (await calendar.fresh(input, minimum)) continue;
      const rows = await source.portfolioNights(range.fromOn, range.toOn);
      refreshed += await calendar.publish(input, rows);
    }
    return refreshed;
  }, { isolationLevel: "RepeatableRead" });
}
