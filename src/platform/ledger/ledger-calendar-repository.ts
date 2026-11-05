import type { TenantTransaction } from "@/platform/db/tenant";
import { calendarDateAt } from "@/i18n/format";
import { calendarDateStart } from "@/platform/time/calendar";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { accountingPeriodPolicyKey, accountingPeriodPolicySchema } from "@/modules/finance/domain/accounting-period";

export class LedgerCalendarConfigurationError extends Error {
  constructor() { super("ledger_calendar_configuration_unavailable"); }
}

/** Shared civil-date boundaries for financial posting readers and their documents. */
export class LedgerCalendarRepository {
  constructor(protected readonly tx: TenantTransaction, protected readonly organizationId: string) {}

  async settings() {
    const [organization, profile, currencies] = await Promise.all([
      this.tx.organization.findUniqueOrThrow({ where: { id: this.organizationId }, select: { baseCurrency: true } }),
      this.tx.organizationProfile.findFirst({ where: { organizationId: this.organizationId }, select: { timezone: true } }),
      this.tx.currency.findMany({ orderBy: { code: "asc" }, select: { code: true } })
    ]);
    return { baseCurrency: organization.baseCurrency, timezone: profile?.timezone, currencies };
  }

  async configuration() {
    const [clock] = await this.tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const [settings, rule] = await Promise.all([this.settings(), new ConfigRuleRepository(this.tx, this.organizationId).resolve({ key: accountingPeriodPolicyKey,
      scopes: [{ scopeType: "organization", scopeId: null }], asOf: clock.now })]);
    const timezone = rule ? accountingPeriodPolicySchema.parse(rule.value).timezone : settings.timezone;
    if (!timezone) throw new LedgerCalendarConfigurationError();
    requireCurrentTimezoneData();
    return { ...settings, timezone, policyId: rule?.id ?? null, now: clock.now };
  }

  defaults(now: Date, timezone: string) {
    requireCurrentTimezoneData();
    const fromOn = calendarDateAt(now, timezone).slice(0, 7) + "-01", last = new Date(fromOn + "T00:00:00.000Z");
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    return Promise.resolve({ fromOn, toOn: last.toISOString().slice(0, 10) });
  }

  range(fromOn: string, toOn: string, timezone: string) {
    requireCurrentTimezoneData();
    const next = new Date(toOn + "T00:00:00.000Z");
    next.setUTCDate(next.getUTCDate() + 1);
    return Promise.resolve({ startsAt: calendarDateStart(fromOn, timezone), endsAt: calendarDateStart(next.toISOString().slice(0, 10), timezone) });
  }
}
