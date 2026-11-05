import { z } from "zod";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { externalRefundSupervisionReviewInput, externalRefundSupervisionFeeInput, externalRefundSupervisionAdmissionInput } from "./external-payment-refund-supervision";

const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/u), instant = z.iso.datetime(), money = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict();
export const externalRefundSupervisionListInput = z.object({ depositId: id, after: z.string().max(2048).optional() }).strict();
export const externalRefundSupervisionListSchema = z.object({ items: z.array(z.object({ intentId: id, refundId: z.string(), originalRequestedBy: id, amount: money,
  returnedFee: money, refundedAt: instant }).strict()).max(50), next: z.string().max(2048).nullable() }).strict();
export const externalRefundSupervisionReviewSchema = z.object({ reviewId: id, intentId: id, originalRequestedBy: id, prospectiveAdmitter: id, amount: money,
  refundedAt: instant, settlement: providerRefundSettlementSchema, reason: externalRefundSupervisionReviewInput.shape.reason, reviewFingerprint: hash }).strict();
export const externalRefundSupervisedAdmissionReviewSchema = externalRefundSupervisionReviewSchema.omit({ settlement: true });
export const externalRefundSupervisedReceiptSchema = z.object({ requestId: id, idempotencyKey: id, state: z.literal("SUCCEEDED"), failureCode: z.null(), id, intentId: id,
  depositId: id, operation: z.literal("REFUND"), idempotent: z.boolean(), reviewId: id, reviewFingerprint: hash, reason: externalRefundSupervisionReviewInput.shape.reason }).strict()
  .refine(value => value.requestId === value.idempotencyKey, "supervised_command_nonce_required");
export const externalRefundSupervisedRecoverySchema = z.object({ request: externalRefundSupervisedReceiptSchema.nullable() }).strict();
export const externalRefundSupervisionReadInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("LIST"), input: externalRefundSupervisionListInput }).strict(),
  z.object({ operation: z.literal("REVIEW"), input: externalRefundSupervisionReviewInput }).strict(),
  z.object({ operation: z.literal("REVIEW_ADMISSION"), input: externalRefundSupervisionReviewInput }).strict(),
  z.object({ operation: z.literal("GET_FEE"), input: externalRefundSupervisionFeeInput }).strict()
]);
export const externalRefundSupervisionCommandInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("PREPARE_FEE"), input: externalRefundSupervisionFeeInput }).strict(),
  z.object({ operation: z.literal("ADMIT"), input: externalRefundSupervisionAdmissionInput }).strict()
]);
