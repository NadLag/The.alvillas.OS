import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { externalRefundViewSchema, externalRefundReceiptSchema, externalRefundRecoverySchema, externalRefundAdmissionRecoverySchema, externalRefundAdmissionReceiptSchema, externalRefundCommandSchema, externalRefundFeePlanSchema, acceptExternalRefund } from "@/modules/finance/domain/external-payment-refund-workspace";
import { externalRefundCommandInput, externalRefundReadInput } from "@/modules/finance/domain/external-payment-refund-command";

const id = randomUUID(), captureId = randomUUID(), depositId = randomUUID(), nonce = randomUUID(), amount = { amount: "0.07", currency: "MAD" },
  refund = { depositId, accountId: randomUUID(), ...amount, method: "verified_paypal", externalReference: null, purpose: "Return original guest funds", reason: "Approved original refund request", reviewFingerprint: "a".repeat(64), idempotencyKey: nonce },
  pending = { id, captureId, depositId, idempotencyKey: nonce, idempotent: false, amount, input: { captureId, refund }, state: "QUEUED", refundId: null, refundedAt: null, settlement: null, admission: null },
  completed = { ...pending, state: "COMPLETED", refundId: "VERIFIED_REFUND_1", refundedAt: "2026-11-05T09:00:00.000Z", settlement: { schemaVersion: 1, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN", gross: amount, fee: { amount: "0.02", currency: "MAD" }, net: { amount: "0.05", currency: "MAD" }, totalRefunded: amount } };

describe("original provider refund workspace", () => {
  it("distinguishes an unprepared credit, an approved remaining expense and a fully credited original cost", () => {
    const plan = { intentId: id, bindingId: null, expenseId: null, state: "UNPREPARED", returnedFee: { amount: "0.01", currency: "MAD" }, remainingCost: { amount: "0.01", currency: "MAD" } };
    expect(externalRefundFeePlanSchema.parse(plan).state).toBe("UNPREPARED");
    expect(externalRefundFeePlanSchema.parse({ ...plan, bindingId: randomUUID(), expenseId: randomUUID(), state: "APPROVED" }).state).toBe("APPROVED");
    expect(externalRefundFeePlanSchema.parse({ ...plan, bindingId: randomUUID(), state: "READY", remainingCost: { amount: "0.00", currency: "MAD" } }).state).toBe("READY");
  });
  it.each([
    { returnedFee: { amount: "0.00", currency: "MAD" } }, { returnedFee: { amount: "0.001", currency: "MAD" } },
    { remainingCost: { amount: "0.01", currency: "EUR" } }, { state: "APPROVED", expenseId: null },
    { state: "READY", remainingCost: { amount: "0.01", currency: "MAD" } },
    { state: "READY", expenseId: randomUUID(), remainingCost: { amount: "0.00", currency: "MAD" } }
  ])("rejects incomplete or contradictory original cost credit evidence %#", patch => {
    const plan = { intentId: id, bindingId: randomUUID(), expenseId: randomUUID(), state: "APPROVED", returnedFee: { amount: "0.01", currency: "MAD" }, remainingCost: { amount: "0.01", currency: "MAD" } };
    expect(externalRefundFeePlanSchema.safeParse({ ...plan, ...patch }).success).toBe(false);
  });
  it.each(["amount", "returnedFee", "expenseId"])("rejects caller-supplied %s at the metadata-only original fee command boundary", field => {
    expect(externalRefundCommandInput.safeParse({ operation: "PREPARE_FEE", input: { intentId: id, [field]: field === "expenseId" ? randomUUID() : "0.01" } }).success).toBe(false);
    expect(externalRefundReadInput.safeParse({ operation: "GET_FEE", input: { intentId: id, [field]: "0.01" } }).success).toBe(false);
  });
  it("requires a distinct native cancellation witness and never treats provider failure or cancellation as a release", () => {
    const cancellation = { actorId: randomUUID(), reason: "Original request cancelled before any provider attempt", occurredAt: "2026-11-05T09:00:00.000Z" };
    expect(externalRefundReceiptSchema.parse({ ...pending, state: "RELEASED", cancellation })).toMatchObject({ sourceState: "RELEASED", state: "SUCCEEDED", admission: null, refundedAt: null, cancellation });
    expect(externalRefundViewSchema.safeParse({ ...pending, state: "RELEASED" }).success).toBe(false);
    expect(externalRefundViewSchema.safeParse({ ...completed, state: "RELEASED", cancellation }).success).toBe(false);
    for (const state of ["PENDING", "FAILED", "CANCELLED"]) expect(externalRefundViewSchema.safeParse({ ...pending, state, cancellation }).success).toBe(false);
  });
  it.each(["QUEUED", "UNCONFIRMED", "PENDING", "FAILED", "CANCELLED"])("retains %s source claims for recovery without asserting financial success or releasing funds", state => {
    expect(externalRefundRecoverySchema.parse({ request: { ...pending, state } }).request).toMatchObject({ requestId: id, idempotencyKey: nonce, state: "PENDING", sourceState: state, failureCode: null, admission: null });
    expect(externalRefundAdmissionRecoverySchema.parse({ request: { ...pending, state } })).toEqual({ request: null });
  });
  it("distinguishes confirmed physical money from canonical journal admission", () => {
    expect(externalRefundReceiptSchema.parse(completed)).toMatchObject({ state: "SUCCEEDED", sourceState: "COMPLETED", refundedAt: completed.refundedAt, admission: null });
    expect(externalRefundAdmissionRecoverySchema.parse({ request: completed })).toEqual({ request: null });
    expect(externalRefundAdmissionReceiptSchema.safeParse(completed).success).toBe(false);
  });
  it("recovers only actual original admission at the provider economic date", () => {
    const transactionId = randomUUID(), admitted = { ...completed, admission: { state: "ADMITTED", transactionId, occurredAt: completed.refundedAt } };
    expect(externalRefundAdmissionRecoverySchema.parse({ request: admitted }).request).toMatchObject({ state: "SUCCEEDED", idempotencyKey: nonce, admission: { transactionId } });
    expect(externalRefundViewSchema.safeParse({ ...admitted, admission: { ...admitted.admission, occurredAt: "2026-11-05T10:00:00.000Z" } }).success).toBe(false);
  });
  it.each(["captureId", "depositId", "idempotencyKey"])("rejects redirected original %s", field => {
    expect(externalRefundViewSchema.safeParse({ ...completed, [field]: randomUUID() }).success).toBe(false);
  });
  it.each(["refundId", "refundedAt"])("requires actual provider %s before completion", field => {
    expect(externalRefundViewSchema.safeParse({ ...completed, [field]: null }).success).toBe(false);
  });
  it.each(["0.04", "0.06"])("rejects a nonconserving merchant debit of %s", value => {
    expect(externalRefundViewSchema.safeParse({ ...completed, settlement: { ...completed.settlement, net: { amount: value, currency: "MAD" } } }).success).toBe(false);
  });
  it.each(["gross", "fee", "net"] as const)("rejects foreign-currency %s rather than inventing a conversion", field => {
    expect(externalRefundViewSchema.safeParse({ ...completed, settlement: { ...completed.settlement, [field]: { ...completed.settlement[field], currency: "EUR" } } }).success).toBe(false);
  });
  it("retains absent settlement without guessing a zero fee", () => {
    expect(externalRefundViewSchema.parse({ ...completed, settlement: null }).settlement).toBeNull();
    expect(externalRefundViewSchema.safeParse({ ...pending, refundedAt: completed.refundedAt }).success).toBe(false);
  });
  it("correlates source, exact Money, account, method, purpose, reason and nonce", () => {
    const { idempotencyKey: ignored, ...facts } = refund; void ignored;
    const input = externalRefundCommandSchema.parse({ captureId, refund: facts, idempotencyKey: nonce }), receipt = externalRefundReceiptSchema.parse(completed);
    expect(acceptExternalRefund(receipt, input, nonce)).toBe(true); expect(acceptExternalRefund(receipt, null, nonce)).toBe(true);
    expect(acceptExternalRefund(receipt, input, randomUUID())).toBe(false);
    expect(acceptExternalRefund(receipt, { ...input, captureId: randomUUID() }, nonce)).toBe(false);
    for (const [field, value] of Object.entries({ depositId: randomUUID(), accountId: randomUUID(), amount: "0.08", currency: "EUR", method: "bank", purpose: "Different source", reason: "Different refund reason", reviewFingerprint: "b".repeat(64) }))
      expect(acceptExternalRefund(receipt, { ...input, refund: { ...input.refund, [field]: value } }, nonce), field).toBe(false);
  });
});
