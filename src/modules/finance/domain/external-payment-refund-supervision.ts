import { z } from "zod";
import { externalRefundIdentityInput } from "./external-payment-refund-command";
import { guestDepositRefundInput } from "./guest-deposit-command";
import { authorizationCapSchema } from "@/platform/authz/authorization-cap";

/** Financial supervision can reauthorize the original fact, never replace its actor, source or Money. */
export const externalRefundSupervisionReviewInput = externalRefundIdentityInput.extend({ reason: guestDepositRefundInput.shape.reason }).strict();
export const externalRefundSupervisionAdmissionInput = externalRefundSupervisionReviewInput.extend({ reviewId: z.uuid().transform(value => value.toLowerCase()),
  reviewFingerprint: guestDepositRefundInput.shape.reviewFingerprint, idempotencyKey: z.uuid().transform(value => value.toLowerCase()) }).strict();
export const externalRefundSupervisionRecoveryInput = z.object({ key: z.uuid().transform(value => value.toLowerCase()) }).strict();
export const externalRefundSupervisionFeeInput = externalRefundSupervisionReviewInput.extend({ reviewId: z.uuid(), reviewFingerprint: guestDepositRefundInput.shape.reviewFingerprint }).strict();
export const externalRefundSupervisedAdmissionReview = z.object({ schemaVersion: z.literal(1), reviewId: z.uuid(), intentId: z.uuid(),
  reviewFingerprint: guestDepositRefundInput.shape.reviewFingerprint, sourceFingerprint: guestDepositRefundInput.shape.reviewFingerprint,
  guestRefundFingerprint: guestDepositRefundInput.shape.reviewFingerprint, reason: guestDepositRefundInput.shape.reason,
  originalRequestedBy: z.uuid(), originalRequestKey: z.uuid(), originalRequestFingerprint: guestDepositRefundInput.shape.reviewFingerprint,
  settlementId: z.uuid(), firstEvidenceId: z.uuid(), refundedAt: z.iso.datetime({ offset: true }), authorizationCap: authorizationCapSchema }).strict();
