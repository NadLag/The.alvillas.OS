import { z } from "zod";
import { guestDepositReceiptInput, guestDepositReviewInput } from "./guest-deposit-command";

const identity = z.uuid().transform(value => value.toLowerCase());
export const externalPaymentIdentityInput = z.object({ id: identity }).strict();
export const externalPaymentRecoveryInput = z.object({ key: identity }).strict();
export const externalPaymentIntentInput = z.object({ provider: z.literal("paypal"), orderId: z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u),
  receipt: guestDepositReceiptInput.extend({ paymentMethodFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }) }).strict();
export const externalPaymentReviewInput = z.object({ provider: externalPaymentIntentInput.shape.provider, orderId: externalPaymentIntentInput.shape.orderId,
  receipt: guestDepositReviewInput }).strict();
export const capturedPayPalAdmissionInput = z.object({ intentId: identity, reviewFingerprint: guestDepositReceiptInput.shape.reviewFingerprint,
  paymentMethodFingerprint: externalPaymentIntentInput.shape.receipt.shape.paymentMethodFingerprint, reason: guestDepositReceiptInput.shape.reason }).strict();
export const externalPaymentReadInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("REVIEW_CAPTURE"), input: externalPaymentReviewInput }).strict(),
  z.object({ operation: z.literal("GET"), input: externalPaymentIdentityInput }).strict(),
  z.object({ operation: z.literal("REVIEW_ADMISSION"), input: externalPaymentIdentityInput }).strict(),
]);
export const externalPaymentCommandInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("CAPTURE"), input: externalPaymentIntentInput }).strict(),
  z.object({ operation: z.literal("RECONCILE"), input: externalPaymentIdentityInput }).strict(),
  z.object({ operation: z.literal("ADMIT"), input: capturedPayPalAdmissionInput }).strict(),
]);
