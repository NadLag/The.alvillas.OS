import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertExternalPaymentRefund, retainExternalPaymentRefund, verifiedExternalPaymentRefund } from "@/modules/finance/domain/external-payment-refund-intent";
import { externalRefundSupervisionReviewInput, externalRefundSupervisionAdmissionInput } from "@/modules/finance/domain/external-payment-refund-supervision";

const organizationId = randomUUID(), originalActor = randomUUID(), supervisor = randomUUID(), intentId = randomUUID(), reason = "Independently review the original already-paid refund under current financial authority";
const input = () => ({ captureId: randomUUID(), refund: { depositId: randomUUID(), accountId: randomUUID(), amount: "0.03", currency: "MAD", method: "original-paypal", externalReference: null,
  purpose: "Original guest refund", reason: "Original attributed refund reason", reviewFingerprint: "a".repeat(64), idempotencyKey: randomUUID() } });
const record = () => { const saved = retainExternalPaymentRefund(input(), organizationId, originalActor); return { input: saved.input, organizationId, requestedBy: originalActor, requestFingerprint: saved.fingerprint, canonicalRequest: saved.canonicalRequest }; };
const verifiedRecord = () => {
  const row = record(), at = "2026-11-05T09:00:00.000Z", evidence = { refundId: "ORIGINAL_REFUND_1", captureId: "ORIGINAL_CAPTURE_1", requestId: row.input.refund.idempotencyKey,
    amount: { amount: "0.03", currency: "MAD" }, state: "COMPLETED", createdAt: at, updatedAt: at, refundedAt: at }, settlement = { schemaVersion: 1, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN",
    gross: { amount: "0.03", currency: "MAD" }, fee: { amount: "0.01", currency: "MAD" }, net: { amount: "0.02", currency: "MAD" }, totalRefunded: { amount: "0.03", currency: "MAD" } };
  return { ...row, captureId: row.input.captureId, depositId: row.input.refund.depositId, idempotencyKey: row.input.refund.idempotencyKey, amount: "0.03", currency: "MAD", capture: { paymentId: evidence.captureId },
    identity: { id: randomUUID(), refundId: evidence.refundId, observations: [{ id: randomUUID(), state: "COMPLETED", refundedAt: new Date(at), evidence, settlement: { id: randomUUID(), settlement } }] } };
};
describe("immutable original refund facts for independent financial supervision", () => {
  it("correlates original request columns, exact provider Money, capture, refund, nonce and settlement without changing their original actor", () => {
    const row = verifiedRecord(), facts = verifiedExternalPaymentRefund(row); expect(facts.saved.requestedBy).toBe(originalActor); expect(facts.settlement.net).toEqual({ amount: "0.02", currency: "MAD" }); expect(facts.observation.id).toBe(row.identity.observations[0].id);
  });
  it.each(["captureId", "depositId", "idempotencyKey", "amount", "currency"] as const)("rejects a contradictory native %s rather than authorizing a different paid fact", field => {
    const row = verifiedRecord(), value = field === "amount" ? "0.04" : field === "currency" ? "EUR" : randomUUID(); expect(() => verifiedExternalPaymentRefund({ ...row, [field]: value })).toThrow();
  });
  it.each(["PENDING", "FAILED", "CANCELLED"])("does not treat %s observations as financial admission authority", state => {
    const row = verifiedRecord(); expect(() => verifiedExternalPaymentRefund({ ...row, identity: { ...row.identity, observations: [{ ...row.identity.observations[0], state }] } })).toThrow();
  });
  it("retains the original requester and exact Money rather than impersonating a prospective supervisor", () => {
    const row = record(), saved = assertExternalPaymentRefund(row); expect(saved.requestedBy).toBe(originalActor); expect(saved.requestedBy).not.toBe(supervisor); expect(saved.input.refund.amount).toBe("0.03"); expect(saved.canonicalRequest).toBe(row.canonicalRequest);
  });
  it.each(["organizationId", "requestedBy", "requestFingerprint", "canonicalRequest"] as const)("rejects a substituted original %s", field => {
    const row = record(), value = field === "requestFingerprint" ? "b".repeat(64) : field === "canonicalRequest" ? "{}" : randomUUID();
    expect(() => assertExternalPaymentRefund({ ...row, [field]: value })).toThrow();
  });
  it("rejects a changed original amount or refund nonce while retaining its original fingerprint", () => {
    const row = record(); for (const patch of [{ amount: "0.04" }, { idempotencyKey: randomUUID() }]) expect(() => assertExternalPaymentRefund({ ...row, input: { ...row.input, refund: { ...row.input.refund, ...patch } } })).toThrow();
  });
  it("requires a reasoned reference and a distinct command nonce without accepting replacement financial facts", () => {
    expect(externalRefundSupervisionReviewInput.parse({ intentId, reason })).toEqual({ intentId, reason });
    expect(externalRefundSupervisionAdmissionInput.parse({ intentId, reason, reviewId: randomUUID(), reviewFingerprint: "b".repeat(64), idempotencyKey: randomUUID() }).intentId).toBe(intentId);
  });
  it.each(["requestedBy", "actorId", "amount", "currency", "accountId", "captureId"])("rejects caller-supplied %s in a supervisory review or admission", field => {
    expect(externalRefundSupervisionReviewInput.safeParse({ intentId, reason, [field]: randomUUID() }).success).toBe(false);
    expect(externalRefundSupervisionAdmissionInput.safeParse({ intentId, reason, reviewId: randomUUID(), reviewFingerprint: "b".repeat(64), idempotencyKey: randomUUID(), [field]: randomUUID() }).success).toBe(false);
  });
});
