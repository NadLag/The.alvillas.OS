import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { accountingPeriodPolicySchema, accountingPeriodState, closeAccountingPeriodSchema, reopenAccountingPeriodSchema } from "@/modules/finance/domain/accounting-period";

it("requires explicit accounting timezone, early-close choice and reopening limit", () => {
  const policy = { timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 120 };
  expect(accountingPeriodPolicySchema.parse(policy)).toEqual(policy);
  for (const value of [{ timezone: "Europe/Paris" }, { ...policy, max_reopen_seconds: 0 }, { ...policy, timezone: "invalid/accounting-zone" }])
    expect(accountingPeriodPolicySchema.safeParse(value).success).toBe(false);
});
it("closes a reopening window exactly at the supplied authoritative time", () => {
  const event = { kind: "REOPEN", reopensUntil: new Date("2024-10-31T23:00:00.000Z") };
  expect(accountingPeriodState(event, new Date("2024-10-31T22:59:59.999Z"))).toBe("REOPENED");
  expect(accountingPeriodState(event, event.reopensUntil)).toBe("CLOSED");
  expect(accountingPeriodState({ kind: "CLOSE", reopensUntil: null }, new Date("2024-01-01"))).toBe("CLOSED");
});
it("canonicalizes request keys and rejects incomplete or invalid period commands", () => {
  const key = randomUUID(), input = { month: "2024-10", expectedVersion: 0, reason: "  Reconciled financial month  ", idempotencyKey: key.toUpperCase() };
  expect(closeAccountingPeriodSchema.parse(input)).toMatchObject({ idempotencyKey: key, reason: "Reconciled financial month" });
  expect(closeAccountingPeriodSchema.safeParse({ ...input, month: "2024-13" }).success).toBe(false);
  expect(closeAccountingPeriodSchema.safeParse({ ...input, reason: "" }).success).toBe(false);
  expect(reopenAccountingPeriodSchema.safeParse({ periodId: randomUUID(), expectedVersion: 1, reason: "Reasoned correction", durationSeconds: 0, idempotencyKey: key }).success).toBe(false);
});
