import { CronExpressionParser } from "cron-parser";
import { Temporal } from "temporal-polyfill";
import type { PayoutScheduleConfig } from "@/platform/config/rule-registry";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";

export class PayoutScheduleConfigurationError extends Error {}
function requirePayoutTimezoneData() {
  try { requireCurrentTimezoneData(); }
  catch { throw new PayoutScheduleConfigurationError("Payout scheduling requires current IANA timezone data"); }
}
export type PayoutScheduleTiming = {
  checkoutDate?: Date;
  completedAt?: Date;
  settlementAt?: Date;
  triggeredAt: Date;
  timezone?: string;
  hashSeed?: string;
};

function cronAtOrAfter(expression: string, minimum: Date, timezone: string, seed?: string): Date {
  try {
    return CronExpressionParser.parse(expression, { currentDate: new Date(minimum.getTime() - 1), tz: timezone, hashSeed: seed ?? expression }).next().toDate();
  } catch { throw new PayoutScheduleConfigurationError("Payout cron schedule is invalid"); }
}

/** A local clock label identifies one slot even when its offset repeats at DST fall-back. */
export function payoutScheduleSlot(at: Date, timezone: string): string {
  requirePayoutTimezoneData();
  return Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: "second" });
}

export function payoutEligibility(config: PayoutScheduleConfig, subject: PayoutScheduleTiming): { eligibleOn: Date; timezone: string } {
  const timezone = config.schedule?.timezone ?? subject.timezone;
  const base = config.cadence === "AFTER_CHECKOUT" ? subject.checkoutDate ?? subject.triggeredAt
    : config.cadence === "PER_BOOKING" ? subject.completedAt ?? subject.checkoutDate ?? subject.triggeredAt
    : config.cadence === "OTA_SPLIT_EXPECTED_SETTLEMENT" ? subject.settlementAt ?? subject.triggeredAt : subject.triggeredAt;
  let minimum: Date;
  if (timezone) {
    requirePayoutTimezoneData();
    try { minimum = new Date(Temporal.Instant.fromEpochMilliseconds(base.getTime()).toZonedDateTimeISO(timezone).add({ days: config.hold_days ?? 0 }).epochMilliseconds); }
    catch { throw new PayoutScheduleConfigurationError("Payout calendar or source instant is invalid"); }
  } else {
    minimum = new Date(base);minimum.setUTCDate(minimum.getUTCDate() + (config.hold_days ?? 0));
    if (!Number.isFinite(minimum.getTime())) throw new PayoutScheduleConfigurationError("Payout source instant is invalid");
  }
  const eventBased = ["AFTER_CHECKOUT", "PER_BOOKING", "OTA_SPLIT_EXPECTED_SETTLEMENT"].includes(config.cadence);
  if (eventBased && !config.schedule?.at) return { eligibleOn: minimum, timezone: timezone ?? "UTC" };
  if (!timezone) throw new PayoutScheduleConfigurationError("Payout schedule requires its configured timezone");
  if (config.cadence === "CUSTOM_CRON") {
    if (!config.cron) throw new PayoutScheduleConfigurationError("Custom payout schedule requires its cron expression");
    return { eligibleOn: cronAtOrAfter(config.cron, minimum, timezone, subject.hashSeed), timezone };
  }
  const at = config.schedule?.at;
  if (!at) throw new PayoutScheduleConfigurationError("Payout schedule requires its configured local time");
  const [hour, minute] = at.split(":").map(Number);
  if (eventBased) return { eligibleOn: cronAtOrAfter(`${minute} ${hour} * * *`, minimum, timezone), timezone };
  if (config.cadence === "WEEKLY") {
    if (config.schedule?.weekday === undefined) throw new PayoutScheduleConfigurationError("Weekly payout schedule requires its configured weekday");
    return { eligibleOn: cronAtOrAfter(`${minute} ${hour} * * ${config.schedule.weekday}`, minimum, timezone), timezone };
  }
  if (config.cadence === "MONTHLY") {
    if (config.schedule?.month_day === undefined) throw new PayoutScheduleConfigurationError("Monthly payout schedule requires its configured day");
    const day = config.schedule.month_day === "LAST" ? "L" : config.schedule.month_day;
    return { eligibleOn: cronAtOrAfter(`${minute} ${hour} ${day} * *`, minimum, timezone), timezone };
  }
  if (!config.schedule?.anchor_on) throw new PayoutScheduleConfigurationError("Fifteen-day payout schedule requires its configured anchor");
  const anchor = Temporal.PlainDate.from(config.schedule.anchor_on), localMinimum = Temporal.Instant.fromEpochMilliseconds(minimum.getTime()).toZonedDateTimeISO(timezone);
  const elapsed = anchor.until(localMinimum.toPlainDate(), { largestUnit: "day" }).days;
  let day = anchor.add({ days: Math.max(0, Math.floor(elapsed / 15)) * 15 });
  let next = day.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from(at) });
  if (next.epochMilliseconds < minimum.getTime()) {
    day = day.add({ days: 15 });next = day.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from(at) });
  }
  return { eligibleOn: new Date(next.epochMilliseconds), timezone };
}
