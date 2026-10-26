import { describe, expect, it } from "vitest";
import { expenseRevenueWindow } from "@/modules/finance/application/expense-submission-policy";
import { evaluateConfiguredApproval } from "@/modules/finance/domain/configured-finance-rules";
import { Money } from "@/platform/money/money";

describe("configured native expense approval policy", () => {
  it("uses property calendar month boundaries across daylight saving time", () => {
    expect(expenseRevenueWindow({ thresholds: [], revenue_period: { unit: "MONTH" } }, "2026-03-18", "America/New_York", null)).toEqual({
      startsAt: new Date("2026-03-01T05:00:00Z"), endsAt: new Date("2026-04-01T04:00:00Z") });
  });
  it("uses configured calendar years and rolling days without fixed-duration timezone arithmetic", () => {
    expect(expenseRevenueWindow({ thresholds: [], revenue_period: { unit: "YEAR" } }, "2026-10-26", "Europe/Paris", null)).toEqual({
      startsAt: new Date("2025-12-31T23:00:00Z"), endsAt: new Date("2026-12-31T23:00:00Z") });
    expect(expenseRevenueWindow({ thresholds: [], revenue_period: { unit: "ROLLING_DAYS", days: 3 } }, "2026-03-09", "America/New_York", null)).toEqual({
      startsAt: new Date("2026-03-07T05:00:00Z"), endsAt: new Date("2026-03-10T04:00:00Z") });
  });
  it("requires an explicit revenue period and an actual reservation for reservation percentages", () => {
    expect(() => expenseRevenueWindow({ thresholds: [] }, "2026-10-26", "Africa/Casablanca", null)).toThrow("configured revenue period");
    expect(() => expenseRevenueWindow({ thresholds: [], revenue_period: { unit: "RESERVATION" } }, "2026-10-26", "Africa/Casablanca", null)).toThrow("source reservation");
    expect(expenseRevenueWindow({ thresholds: [], revenue_period: { unit: "RESERVATION" } }, "2026-10-26", "Africa/Casablanca", "dedicated-reservation")).toEqual({ reservationId: "dedicated-reservation" });
  });
  it("honors a category's named approval threshold and rejects missing configured keys", () => {
    const config = { thresholds: [{ key: "other", requires_approval_from: ["none"] }, { key: "maintenance", amount: "100", currency: "MAD", requires_approval_from: ["owner"] }] };
    const subject = { amount: Money.of("500.25", "MAD"), category: "maintenance", ruleKey: "maintenance" };
    expect(evaluateConfiguredApproval(config, subject).requiredSteps).toEqual(["owner"]);
    expect(() => evaluateConfiguredApproval(config, { ...subject, ruleKey: "absent" })).toThrow("rule key is missing");
  });
});
