import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { expenseOccurredAt, expenseResource, viewableExpenseResource } from "@/platform/authz/expense-resource";

const organizationId = randomUUID(), actorId = randomUUID(), property = { id: randomUUID(), timezone: "UTC" }, occurredOn = new Date("2026-11-05T00:00:00Z"), capturedAt = new Date("2026-11-05T15:00:00Z"),
  facts = { id: randomUUID(), amount: "0.02", state: "DRAFT", occurredOn, createdBy: actorId }, native = { ...facts, externalPaymentFee: { capture: { capturedAt } } };
describe("canonical native expense source time", () => {
  it("retains civil-day behavior for ordinary expenses", () => {
    expect(expenseOccurredAt(property, facts)).toEqual(occurredOn); expect(expenseResource(organizationId, property, facts).occurredAt).toEqual(occurredOn);
  });
  it("uses the retained actual provider time even when a legacy caller supplies a civil-day instant", () => {
    expect(expenseOccurredAt(property, { ...native, occurredAt: occurredOn })).toEqual(capturedAt);
    expect(expenseResource(organizationId, property, { ...native, occurredAt: occurredOn }).occurredAt).toEqual(capturedAt);
  });
  it("does not convert an unavailable actual provider timestamp into a guessed ordinary date", () => {
    expect(() => expenseOccurredAt(property, { ...facts, externalPaymentFee: { capture: { capturedAt: null } } })).toThrow("Actual original provider fee time required");
  });
  it("applies date-scoped expense access to the original economic time", () => {
    const ctx: AuthContext = { organizationId, userAccountId: actorId, permissions: new Set(["expense:view"]), scopes: [{ organizationId, scopeType: "organization" }],
      assignments: [{ scope: { organizationId, scopeType: "organization" }, permissions: new Set(["expense:view"]), conditions: { timeWindow: { endsAt: "2026-11-05T12:00:00Z" } } }] };
    expect(authorize(ctx, "view", expenseResource(organizationId, property, facts))).toBe(true);
    expect(authorize(ctx, "view", expenseResource(organizationId, property, native))).toBe(false);
    expect(viewableExpenseResource(ctx, property, native, [randomUUID()])).toBeNull();
  });
  it("uses the first verified refund date for a corrected provider cost and its financial audit resource", () => {
    const refundedAt = new Date("2026-12-01T01:02:03.004Z"), correction = { ...facts, externalPaymentRefundFeeCorrection: { refundIntent: { identity: { observations: [{ refundedAt }] } } } };
    expect(expenseOccurredAt(property, { ...correction, occurredAt: occurredOn })).toEqual(refundedAt);
    expect(expenseResource(organizationId, property, correction).occurredAt).toEqual(refundedAt);
    const ctx: AuthContext = { organizationId, userAccountId: actorId, permissions: new Set(["expense:view"]), scopes: [{ organizationId, scopeType: "organization" }], assignments: [{ scope: { organizationId, scopeType: "organization" }, permissions: new Set(["expense:view"]), conditions: { timeWindow: { endsAt: "2026-11-30T23:59:59Z" } } }] };
    expect(viewableExpenseResource(ctx, property, correction, [])).toBeNull();
  });
  it("requires an actual retained completion date rather than guessing the correction's original civil day", () => {
    expect(() => expenseOccurredAt(property, { ...facts, externalPaymentRefundFeeCorrection: { refundIntent: { identity: null } } })).toThrow("Actual original provider fee return time required");
  });
});
