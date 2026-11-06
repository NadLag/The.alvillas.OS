import { z } from "zod";
import { guestDepositRefundInput, guestDepositRefundReviewInput } from "./guest-deposit-command";
const identity = z.uuid().transform(value => value.toLowerCase());
export const externalRefundIdentityInput = z.object({ intentId: identity }).strict();
export const externalRefundRecoveryInput = z.object({ key: identity }).strict();
export const externalRefundReviewInput = z.object({ captureId: identity, refund: guestDepositRefundReviewInput.extend({ externalReference: z.null() }) }).strict();
export const externalRefundRequestInput = z.object({ captureId: identity, refund: guestDepositRefundInput.extend({ externalReference: z.null() }) }).strict();
export const externalRefundAdmissionInput = externalRefundIdentityInput.extend({ reviewFingerprint: guestDepositRefundInput.shape.reviewFingerprint }).strict();
export const externalRefundCancellationInput = externalRefundIdentityInput.extend({ reason: guestDepositRefundInput.shape.reason }).strict();
export const externalRefundReconciliationInput = externalRefundIdentityInput.extend({ refundId: z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u).optional() }).strict();
export const externalRefundReadInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("GET_FEE"), input: externalRefundIdentityInput }).strict(),
  z.object({ operation: z.literal("REVIEW"), input: externalRefundReviewInput }).strict(),
  z.object({ operation: z.literal("GET"), input: externalRefundIdentityInput }).strict(),
  z.object({ operation: z.literal("REVIEW_ADMISSION"), input: externalRefundIdentityInput }).strict()
]);
export const externalRefundCommandInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("PREPARE_FEE"), input: externalRefundIdentityInput }).strict(),
  z.object({ operation: z.literal("CANCEL"), input: externalRefundCancellationInput }).strict(),
  z.object({ operation: z.literal("REQUEST"), input: externalRefundRequestInput }).strict(),
  z.object({ operation: z.literal("ADMIT"), input: externalRefundAdmissionInput }).strict(),
  z.object({ operation: z.literal("RECONCILE"), input: externalRefundReconciliationInput }).strict()
]);
