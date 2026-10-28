import type { TenantTransaction } from "@/platform/db/tenant";
import { calendarDateAt } from "@/i18n/format";
import { calendarDateStart } from "@/platform/time/calendar";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";

/** Shared civil-date boundaries for financial posting readers. */
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
