import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertExternalPaymentIntent, retainExternalPaymentIntent, ExternalPaymentIntentError } from "@/modules/finance/domain/external-payment-intent";

function original() {
  return { organizationId: randomUUID(), actorId: randomUUID(), input: { provider: "paypal", orderId: "ORIGINAL_ORDER_001", receipt: {
    reservationId: randomUUID(), kind: "stay", accountId: randomUUID(), amount: "9007199254740993.07", currency: "MAD", method: "configured-paypal",
    receivedAt: "2026-11-05T00:00:00.000Z", externalReference: "ORIGINAL_ORDER_001", purpose: "Original authorized accommodation receipt",
    reviewFingerprint: "a".repeat(64), paymentMethodFingerprint: "b".repeat(64), idempotencyKey: randomUUID(), reason: "Capture only the original reviewed exact guest payment" } } };
}
describe("durable optional external payment intent", () => {
  it("retains the exact reviewed Money, original order and native receipt without mutating the caller", () => {
    const source = original(), before = structuredClone(source), saved = retainExternalPaymentIntent(source.input, source.organizationId, source.actorId);
    expect(saved.capture).toEqual({ source: source.input.orderId, amount: "9007199254740993.07", currency: "MAD" });
    expect(saved.input).toEqual(source.input); expect(saved.idempotencyKey).toBe(source.input.receipt.idempotencyKey);
    expect(assertExternalPaymentIntent(saved, source.input, source.organizationId, source.actorId)).toEqual(saved);
    expect(source).toEqual(before);
  });
  it("canonicalizes equivalent exact Money while retaining one source identity", () => {
    const source = original(); source.input.receipt.amount = "100";
    const saved = retainExternalPaymentIntent(source.input, source.organizationId, source.actorId);
    source.input.receipt.amount = "100.00";
    expect(assertExternalPaymentIntent(saved, source.input, source.organizationId, source.actorId)).toEqual(saved);
  });
  it.each(["organizationId", "actorId"] as const)("refuses recovery by a substituted %s", field => {
    const source = original(), saved = retainExternalPaymentIntent(source.input, source.organizationId, source.actorId);
    source[field] = randomUUID();
    expect(() => assertExternalPaymentIntent(saved, source.input, source.organizationId, source.actorId)).toThrow(ExternalPaymentIntentError);
  });
  it.each(["reservationId", "accountId", "idempotencyKey"] as const)("binds the original native %s", field => {
    const source = original(), saved = retainExternalPaymentIntent(source.input, source.organizationId, source.actorId);
    source.input.receipt[field] = randomUUID();
    expect(() => assertExternalPaymentIntent(saved, source.input, source.organizationId, source.actorId)).toThrow(ExternalPaymentIntentError);
  });
  it.each(["method", "purpose", "reason", "reviewFingerprint", "paymentMethodFingerprint", "receivedAt", "currency", "amount"] as const)("refuses a changed reviewed %s", field => {
    const source = original(), saved = retainExternalPaymentIntent(source.input, source.organizationId, source.actorId);
    const changes = { method: "other-paypal", purpose: "Another purpose", reason: "Another explanation of receipt", reviewFingerprint: "c".repeat(64), paymentMethodFingerprint: "d".repeat(64), receivedAt: "2026-11-05T01:00:00.000Z", currency: "EUR", amount: "9007199254740993.08" };
    source.input.receipt[field] = changes[field];
    expect(() => assertExternalPaymentIntent(saved, source.input, source.organizationId, source.actorId)).toThrow(ExternalPaymentIntentError);
  });
  it("identifies one provider order independently of tenant, actor, method, nonce and amount", () => {
    const a = original(), b = original(); b.input.receipt.amount = "0.07";
    const first = retainExternalPaymentIntent(a.input, a.organizationId, a.actorId), other = retainExternalPaymentIntent(b.input, b.organizationId, b.actorId);
    expect(first.sourceIdentity).toBe(other.sourceIdentity); expect(first.fingerprint).not.toBe(other.fingerprint);
  });
  it("requires the original order as the native receipt external reference", () => {
    const source = original(); source.input.receipt.externalReference = "FOREIGN_ORDER";
    expect(() => retainExternalPaymentIntent(source.input, source.organizationId, source.actorId)).toThrow(ExternalPaymentIntentError);
  });
  it.each(["0", "0.00", "-0.07", "1e3", "1.001", "90071992547409930.07"])("rejects invalid provider money %s before any capture", amount => {
    const source = original(); source.input.receipt.amount = amount;
    expect(() => retainExternalPaymentIntent(source.input, source.organizationId, source.actorId)).toThrow(ExternalPaymentIntentError);
  });
});
