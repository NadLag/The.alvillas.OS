import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { externalPaymentIntentViewSchema, externalCaptureReceiptSchema, externalCaptureRecoverySchema, externalAdmissionRecoverySchema, acceptExternalCapture, externalCaptureCommandSchema } from "@/modules/finance/domain/external-payment-workspace";
const id = randomUUID(), nonce = randomUUID(), orderId = "ORIGINAL_REVIEWED_ORDER", amount = { amount: "0.07", currency: "MAD" }, pending = { id, idempotencyKey: nonce, orderId, amount, state: "PENDING", captureId: null, capturedAt: null, observedAt: null, settlement: null, idempotent: false },
  capture = { ...pending, state: "CAPTURED", captureId: randomUUID(), capturedAt: "2026-10-31T23:59:59.000Z", observedAt: "2026-11-05T09:00:00.000Z", settlement: { schemaVersion: 1, basis: "ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN", gross: amount, fee: { amount: "0.02", currency: "MAD" }, net: { amount: "0.05", currency: "MAD" } } };
describe("original external payment workspace acknowledgements", () => {
  it("keeps a pending original capture recoverable without pretending guest money was admitted", () => {
    expect(externalCaptureRecoverySchema.parse({ request: pending }).request).toMatchObject({ requestId: id, idempotencyKey: nonce, state: "PENDING", failureCode: null, admission: null });
    expect(externalAdmissionRecoverySchema.parse({ request: pending })).toEqual({ request: null });
  });
  it("moves a verified capture to admission review while retaining its original economic date and net", () => {
    expect(externalCaptureReceiptSchema.parse(capture)).toMatchObject({ state: "SUCCEEDED", sourceState: "CAPTURED", capturedAt: capture.capturedAt, admission: null, settlement: capture.settlement });
    expect(externalAdmissionRecoverySchema.parse({ request: capture })).toEqual({ request: null });
  });
  it("recovers actual financial success only from the original admitted journal and nonce", () => {
    const transactionId = randomUUID(), original = { ...capture, admission: { state: "ADMITTED", transactionId, depositId: nonce, reversed: false } };
    expect(externalAdmissionRecoverySchema.parse({ request: original }).request).toMatchObject({ requestId: transactionId, depositId: nonce, idempotencyKey: nonce, state: "SUCCEEDED", failureCode: null });
    expect(externalPaymentIntentViewSchema.safeParse({ ...original, admission: { ...original.admission, depositId: randomUUID() } }).success).toBe(false);
  });
  it.each(["captureId", "capturedAt", "observedAt"] as const)("requires actual %s for confirmed capture review", field => {
    expect(externalPaymentIntentViewSchema.safeParse({ ...capture, [field]: null }).success).toBe(false);
  });
  it.each(["0.04", "0.06"])("rejects nonconserving actual merchant net %s", value => {
    expect(externalPaymentIntentViewSchema.safeParse({ ...capture, settlement: { ...capture.settlement, net: { amount: value, currency: "MAD" } } }).success).toBe(false);
  });
  it("does not assume missing settlement means zero deductions", () => {
    expect(externalPaymentIntentViewSchema.parse({ ...capture, settlement: null }).settlement).toBeNull();
    expect(externalPaymentIntentViewSchema.safeParse({ ...pending, settlement: capture.settlement }).success).toBe(false);
  });
  it("correlates the exact reviewed order, source Money and scoped nonce", () => {
    const input = externalCaptureCommandSchema.parse({ provider: "paypal", orderId, idempotencyKey: nonce, receipt: { reservationId: randomUUID(), kind: "stay", accountId: randomUUID(), amount: "0.07", currency: "MAD", method: "confirmed-paypal", receivedAt: "2026-11-05T08:00:00.000Z", externalReference: orderId, purpose: "Original guest payment", reason: "Original reviewed payment request", reviewFingerprint: "a".repeat(64), paymentMethodFingerprint: "b".repeat(64) } }), receipt = externalCaptureReceiptSchema.parse(capture);
    expect(acceptExternalCapture(receipt, input, nonce)).toBe(true); expect(acceptExternalCapture(receipt, null, nonce)).toBe(true);
    expect(acceptExternalCapture(receipt, input, randomUUID())).toBe(false); expect(acceptExternalCapture(receipt, { ...input, orderId: "DIFFERENT_ORDER" }, nonce)).toBe(false);
    expect(acceptExternalCapture(receipt, { ...input, receipt: { ...input.receipt, amount: "0.08" } }, nonce)).toBe(false);
  });
});
