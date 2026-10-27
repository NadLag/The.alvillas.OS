import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Money } from "@/platform/money/money";
import { ownerPayoutDraftSchema, ownerPayoutNextState, ownerPayoutPostings } from "@/modules/finance/domain/owner-payout";

describe("owner payout financial invariants", () => {
  const draft = () => ({ propertyId: randomUUID(), ownerId: randomUUID(), payoutMethodId: randomUUID(), fundingAccountId: randomUUID(),
    amount: "9999999999999999.99", currency: "MAD", purpose: "Approved owner settlement", reason: "Dedicated owner payout acceptance", idempotencyKey: randomUUID() });

  it("retains exact positive cents and normalizes retry identities without accepting arbitrary financial fields", () => {
    const input = draft();
    expect(ownerPayoutDraftSchema.parse({ ...input, amount: "10.1", idempotencyKey: input.idempotencyKey.toUpperCase() })).toMatchObject({ amount: "10.10", idempotencyKey: input.idempotencyKey });
    expect(ownerPayoutDraftSchema.parse(input).amount).toBe(input.amount);
    for (const amount of ["0", "-1.00", "1.005", "1e3", "10000000000000000.00"]) expect(ownerPayoutDraftSchema.safeParse({ ...input, amount }).success).toBe(false);
    expect(ownerPayoutDraftSchema.safeParse({ ...input, state: "PAID" }).success).toBe(false);
    expect(ownerPayoutDraftSchema.safeParse({ ...input, approved: true }).success).toBe(false);
  });

  it("cannot skip approval or scheduling, revive a final state, or cancel paid money without the reversal command", () => {
    let state = ownerPayoutNextState("DRAFT", "submit");
    state = ownerPayoutNextState(state, "approve");state = ownerPayoutNextState(state, "schedule");state = ownerPayoutNextState(state, "pay");
    expect(state).toBe("PAID");expect(ownerPayoutNextState(state, "reconcile")).toBe("RECONCILED");expect(ownerPayoutNextState(state, "reverse")).toBe("CANCELLED");
    for (const state of ["DRAFT", "PENDING_APPROVAL", "APPROVED"] as const) expect(() => ownerPayoutNextState(state, "pay")).toThrow();
    expect(() => ownerPayoutNextState("PAID", "cancel")).toThrow();
    for (const state of ["FAILED", "CANCELLED", "RECONCILED"] as const) for (const command of ["submit", "approve", "schedule", "pay", "reverse"] as const) expect(() => ownerPayoutNextState(state, command)).toThrow();
  });

  it("posts exactly one ownership debit and funding credit with the original owner/property provenance", () => {
    const input = draft(), payoutId = randomUUID(), ownerPayableAccountId = randomUUID(), reservationId = randomUUID();
    const postings = ownerPayoutPostings({ ...input, payoutId, ownerPayableAccountId, reservationId, amount: Money.of(input.amount, input.currency) });
    expect(postings).toHaveLength(2);
    expect(postings.map(row => ({ account: row.ledgerAccountId, side: row.side, amount: row.amount.toJSON(), bucket: row.bucket }))).toEqual([
      { account: ownerPayableAccountId, side: "DEBIT", amount: { amount: input.amount, currency: "MAD" }, bucket: "PAYOUT" },
      { account: input.fundingAccountId, side: "CREDIT", amount: { amount: input.amount, currency: "MAD" }, bucket: "PAYOUT_PAYMENT" }
    ]);
    for (const row of postings) expect(row.dimensions).toEqual({ source: "OWNER_PAYOUT", payout_id: payoutId, owner_id: input.ownerId, property_id: input.propertyId, reservation_id: reservationId });
  });

  it("rejects non-positive payouts and a funding account substituted for the ownership claim", () => {
    const input = { payoutId: randomUUID(), ownerId: randomUUID(), propertyId: randomUUID(), ownerPayableAccountId: randomUUID(), fundingAccountId: randomUUID() };
    for (const amount of ["0.00", "-0.01"]) expect(() => ownerPayoutPostings({ ...input, amount: Money.of(amount, "MAD") })).toThrow();
    expect(() => ownerPayoutPostings({ ...input, ownerPayableAccountId: input.fundingAccountId, amount: Money.of("1.00", "MAD") })).toThrow();
  });
});
