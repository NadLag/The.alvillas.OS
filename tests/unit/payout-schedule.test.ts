import { describe, expect, it, vi } from "vitest";
import { Money } from "@/platform/money/money";
import { planConfiguredPayout } from "@/modules/finance/domain/configured-finance-rules";
import { payoutScheduleSlot, PayoutScheduleConfigurationError } from "@/modules/finance/domain/payout-schedule";
import * as timezoneData from "@/platform/time/timezone-data";

const subject = (at: string, timezone = "UTC") => ({ triggeredAt: new Date(at), timezone, availableBalance: Money.of("10000.00", "MAD") });

describe("configured owner payout calendars", () => {
  it("retains the configured checkout clock through the 23-hour spring calendar day", () => {
    const result = planConfiguredPayout({ cadence: "AFTER_CHECKOUT", hold_days: 1 }, {
      ...subject("2026-03-07T19:00:00Z", "America/Denver"), checkoutDate: new Date("2026-03-07T19:00:00Z")
    });
    expect(result.eligibleOn.toISOString()).toBe("2026-03-08T18:00:00.000Z");
  });

  it("retains the configured checkout clock through the 25-hour fall calendar day", () => {
    const result = planConfiguredPayout({ cadence: "AFTER_CHECKOUT", hold_days: 1 }, {
      ...subject("2026-10-31T18:00:00Z", "America/Denver"), checkoutDate: new Date("2026-10-31T18:00:00Z")
    });
    expect(result.eligibleOn.toISOString()).toBe("2026-11-01T19:00:00.000Z");
  });

  it("uses completed-booking and expected-settlement evidence as their respective hold origins", () => {
    const input = { ...subject("2026-10-27T12:00:00Z"), completedAt: new Date("2026-10-25T10:00:00Z"), settlementAt: new Date("2026-10-26T11:00:00Z") };
    expect(planConfiguredPayout({ cadence: "PER_BOOKING", hold_days: 2 }, input).eligibleOn.toISOString()).toBe("2026-10-27T10:00:00.000Z");
    expect(planConfiguredPayout({ cadence: "OTA_SPLIT_EXPECTED_SETTLEMENT", hold_days: 2 }, input).eligibleOn.toISOString()).toBe("2026-10-28T11:00:00.000Z");
  });

  it("refuses to substitute planned checkout or the request clock for per-booking completion", () => {
    const input = { ...subject("2026-10-27T12:00:00Z"), checkoutDate: new Date("2020-03-08T00:00:00Z") };
    expect(() => planConfiguredPayout({ cadence: "PER_BOOKING" }, input)).toThrow(PayoutScheduleConfigurationError);
    expect(() => planConfiguredPayout({ cadence: "PER_BOOKING" }, subject("2026-10-27T12:00:00Z"))).toThrow(PayoutScheduleConfigurationError);
  });

  it("uses the configured weekday and property timezone without inventing a weekly time", () => {
    const result = planConfiguredPayout({ cadence: "WEEKLY", schedule: { at: "09:00", weekday: 1 } }, subject("2026-10-27T12:00:00Z", "Africa/Casablanca"));
    expect(result.eligibleOn.toISOString()).toBe("2026-11-02T09:00:00.000Z");expect(result.timezone).toBe("Africa/Casablanca");
    expect(() => planConfiguredPayout({ cadence: "WEEKLY" }, subject("2026-10-27T12:00:00Z"))).toThrow(PayoutScheduleConfigurationError);
  });

  it("uses the actual September 2026 Casablanca transition and refuses outdated timezone data", () => {
    const config = { cadence: "WEEKLY", schedule: { at: "09:00", weekday: 1 } };
    expect(planConfiguredPayout(config, subject("2026-09-13T12:00:00Z", "Africa/Casablanca")).eligibleOn.toISOString()).toBe("2026-09-14T08:00:00.000Z");
    expect(planConfiguredPayout(config, subject("2026-09-20T12:00:00Z", "Africa/Casablanca")).eligibleOn.toISOString()).toBe("2026-09-21T09:00:00.000Z");
    const guard = vi.spyOn(timezoneData, "requireCurrentTimezoneData").mockImplementation(() => { throw new Error("digest_timezone_data_outdated"); });
    try {
      expect(() => planConfiguredPayout(config, subject("2026-10-27", "Africa/Casablanca"))).toThrow(PayoutScheduleConfigurationError);
      expect(() => payoutScheduleSlot(new Date("2026-10-27"), "Africa/Casablanca")).toThrow(PayoutScheduleConfigurationError);
    } finally { guard.mockRestore(); }
  });

  it("applies the hold before choosing a weekly slot and includes an exact due instant", () => {
    const config = { cadence: "WEEKLY", hold_days: 1, schedule: { at: "09:00", weekday: 1 } };
    expect(planConfiguredPayout(config, subject("2026-10-26T08:00:00Z")).eligibleOn.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(planConfiguredPayout({ ...config, hold_days: 0 }, subject("2026-10-26T09:00:00Z")).eligibleOn.toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("supports configured month-end and leap years without silently changing a configured day 31", () => {
    const minimum = subject("2028-02-01T10:00:00Z");
    expect(planConfiguredPayout({ cadence: "MONTHLY", schedule: { at: "09:00", month_day: "LAST" } }, minimum).eligibleOn.toISOString()).toBe("2028-02-29T09:00:00.000Z");
    expect(planConfiguredPayout({ cadence: "MONTHLY", schedule: { at: "09:00", month_day: 31 } }, minimum).eligibleOn.toISOString()).toBe("2028-03-31T09:00:00.000Z");
  });

  it("keeps fifteen-day intervals anchored across month boundaries", () => {
    const config = { cadence: "FIFTEEN_DAY", schedule: { at: "09:00", anchor_on: "2026-01-01" } };
    expect(planConfiguredPayout(config, subject("2026-01-16T08:30:00Z")).eligibleOn.toISOString()).toBe("2026-01-16T09:00:00.000Z");
    expect(planConfiguredPayout(config, subject("2026-01-31T09:00:00.001Z")).eligibleOn.toISOString()).toBe("2026-02-15T09:00:00.000Z");
  });

  it("keeps fifteen calendar days through DST and respects a future anchor", () => {
    const config = { cadence: "FIFTEEN_DAY", schedule: { at: "09:00", anchor_on: "2026-02-22" } };
    expect(planConfiguredPayout(config, subject("2026-03-08T19:00:00Z", "America/Denver")).eligibleOn.toISOString()).toBe("2026-03-09T15:00:00.000Z");
    expect(planConfiguredPayout(config, subject("2026-02-01T19:00:00Z", "America/Denver")).eligibleOn.toISOString()).toBe("2026-02-22T16:00:00.000Z");
  });

  it("evaluates custom cron in its configured timezone across a DST weekend", () => {
    const result = planConfiguredPayout({ cadence: "CUSTOM_CRON", cron: "*/15 9-17 * * 1-5", schedule: { timezone: "Europe/Paris" } }, subject("2026-10-23T16:01:00Z"));
    expect(result.eligibleOn.toISOString()).toBe("2026-10-26T08:00:00.000Z");expect(result.timezone).toBe("Europe/Paris");
  });

  it("identifies one civil clock slot during repeated fall-back offsets", () => {
    expect(payoutScheduleSlot(new Date("2026-11-01T07:30:00Z"), "America/Denver")).toBe(payoutScheduleSlot(new Date("2026-11-01T08:30:00Z"), "America/Denver"));
  });

  it("selects the next configured daily clock after an event hold", () => {
    const result = planConfiguredPayout({ cadence: "AFTER_CHECKOUT", hold_days: 1, schedule: { at: "09:00" } }, {
      ...subject("2026-10-27T12:00:00Z"), checkoutDate: new Date("2026-10-26T12:00:00Z")
    });
    expect(result.eligibleOn.toISOString()).toBe("2026-10-28T09:00:00.000Z");
  });

  it("uses the same hash seed for reproducible custom cron slots", () => {
    const config = { cadence: "CUSTOM_CRON", cron: "H 9 * * *" }, input = { ...subject("2026-10-27T08:00:00Z"), hashSeed: "dedicated-owner-property-rule-version" };
    expect(planConfiguredPayout(config, input).eligibleOn.toISOString()).toBe(planConfiguredPayout(config, input).eligibleOn.toISOString());
  });

  it("fails closed on incomplete or invalid schedules and mixed fixed-holdback currency", () => {
    for (const config of [{ cadence: "MONTHLY", schedule: { at: "09:00" } }, { cadence: "FIFTEEN_DAY", schedule: { at: "09:00" } },
      { cadence: "CUSTOM_CRON" }, { cadence: "CUSTOM_CRON", cron: "not a cron expression" }]) expect(() => planConfiguredPayout(config, subject("2026-10-27T08:00:00Z"))).toThrow();
    expect(() => planConfiguredPayout({ cadence: "WEEKLY", schedule: { at: "09:00", weekday: 1 } }, { availableBalance: Money.of("100.00", "MAD"), triggeredAt: new Date("2026-10-27") })).toThrow(PayoutScheduleConfigurationError);
    for (const currency of [undefined, "EUR"]) expect(() => planConfiguredPayout({ cadence: "AFTER_CHECKOUT", holdback_amount: "10.00", holdback_currency: currency }, subject("2026-10-27"))).toThrow(PayoutScheduleConfigurationError);
  });

  it("does not turn an owner debt into a negative percentage holdback or positive payout", () => {
    const result = planConfiguredPayout({ cadence: "AFTER_CHECKOUT", holdback_bps: 2000 }, { ...subject("2026-10-27"), availableBalance: Money.of("-100.00", "MAD") });
    expect(result.holdbackAmount.toJSON().amount).toBe("0.00");expect(result.payableAmount.toJSON().amount).toBe("0.00");
  });

  it("evaluates agreement-specific conditions through the existing rule evaluator and records the selected override", () => {
    const config = { cadence: "MONTHLY", holdback_bps: 1000, schedule: { at: "09:00", month_day: "LAST" }, rules: [{ key: "large_requested_payout", conditions: { path: "payout.amount", op: ">", value: "1000.00" },
      value: { cadence: "WEEKLY", holdback_bps: 2000, schedule: { at: "10:00", weekday: 2 } } }] };
    const input = { ...subject("2026-10-27T11:00:00Z"), availableBalance: Money.of("5000.00", "MAD") };
    const small = planConfiguredPayout(config, { ...input, requestedAmount: Money.of("500.00", "MAD") });
    const large = planConfiguredPayout(config, { ...input, requestedAmount: Money.of("1500.00", "MAD") });
    expect(small.cadence).toBe("MONTHLY");expect(small.matchedRuleKey).toBeNull();
    expect(large.cadence).toBe("WEEKLY");expect(large.matchedRuleKey).toBe("large_requested_payout");expect(large.payableAmount.toJSON().amount).toBe("4000.00");
    expect(large.eligibleOn.toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(() => planConfiguredPayout({ ...config, rules: [{ ...config.rules[0], value: { fundingAccountId: "arbitrary-bank-substitution" } }] }, input)).toThrow();
  });
});
