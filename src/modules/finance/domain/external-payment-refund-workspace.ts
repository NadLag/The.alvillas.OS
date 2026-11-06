import { z } from "zod";
import { Money } from "@/platform/money/money";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { externalRefundRequestInput, externalRefundReviewInput } from "./external-payment-refund-command";

const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/u), instant = z.iso.datetime(),
  money = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict();
export const externalRefundViewSchema = z.object({ id, idempotencyKey: id, captureId: id, depositId: id, idempotent: z.boolean(), amount: money,
  state: z.enum(["QUEUED", "UNCONFIRMED", "PENDING", "COMPLETED", "FAILED", "CANCELLED", "RELEASED"]), refundId: z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u).nullable(), refundedAt: instant.nullable(),
  providerObservation: z.object({ state: z.enum(["PENDING", "COMPLETED", "FAILED", "CANCELLED"]), updatedAt: instant }).strict().nullable().default(null),
  cancellation: z.object({ actorId: id, reason: z.string().min(6).max(500), occurredAt: instant }).strict().nullable().default(null),
  input: externalRefundRequestInput, settlement: providerRefundSettlementSchema.nullable(),
  admission: z.object({ state: z.literal("ADMITTED"), transactionId: id, occurredAt: instant }).strict().nullable()
}).strict().refine(value => value.captureId === value.input.captureId && value.depositId === value.input.refund.depositId && value.idempotencyKey === value.input.refund.idempotencyKey &&
  Money.of(value.amount.amount, value.amount.currency).equals(Money.of(value.input.refund.amount, value.input.refund.currency)), "original_refund_required")
  .refine(value => !value.settlement || value.settlement.gross.currency === value.amount.currency && value.settlement.fee.currency === value.amount.currency && value.settlement.net.currency === value.amount.currency &&
    Money.of(value.amount.amount, value.amount.currency).equals(Money.of(value.settlement.gross.amount, value.settlement.gross.currency)) &&
    Money.of(value.settlement.gross.amount, value.amount.currency).subtract(Money.of(value.settlement.fee.amount, value.amount.currency)).equals(Money.of(value.settlement.net.amount, value.amount.currency)), "verified_settlement_required")
  .refine(value => value.state === "COMPLETED" ? Boolean(value.refundId && value.refundedAt) : !value.refundedAt && !value.admission, "actual_provider_refund_required")
  .refine(value => !value.admission || value.admission.occurredAt === value.refundedAt, "actual_refund_date_required")
  .refine(value => value.state === "RELEASED" ? Boolean(value.cancellation) && !value.refundId && !value.refundedAt && !value.settlement && !value.admission : !value.cancellation, "explicit_unattempted_release_required");
export const externalRefundReceiptSchema = externalRefundViewSchema.transform(value => ({ ...value, sourceState: value.state, requestId: value.id,
  state: value.state === "COMPLETED" || value.state === "RELEASED" ? "SUCCEEDED" as const : "PENDING" as const, failureCode: null }));
export const externalRefundRecoverySchema = z.object({ request: externalRefundViewSchema.nullable() }).strict().transform(({ request }) => ({ request: request ? externalRefundReceiptSchema.parse(request) : null }));
export const externalRefundCommandSchema = externalRefundReviewInput.extend({ idempotencyKey: id, refund: externalRefundRequestInput.shape.refund.omit({ idempotencyKey: true }) }).strict();
export const externalRefundReviewSchema = z.object({ captureId: id, depositId: id, amount: money, account: z.object({ id, name: z.string() }).strict(), reviewFingerprint: hash }).strict();
export const externalRefundAdmissionReviewSchema = z.object({ intentId: id, depositId: id, refundId: z.string(), amount: money, refundedAt: instant, reviewFingerprint: hash }).strict();
export const externalRefundFeePlanSchema = z.object({ intentId: id, bindingId: id.nullable(), expenseId: id.nullable(),
  state: z.enum(["UNPREPARED", "DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "VOIDED", "READY"]), returnedFee: money, remainingCost: money }).strict()
  .refine(value => value.returnedFee.currency === value.remainingCost.currency && Money.of(value.returnedFee.amount, value.returnedFee.currency).amount.gt(0), "original_verified_fee_required")
  .refine(value => value.state === "UNPREPARED" ? !value.bindingId && !value.expenseId : Boolean(value.bindingId), "original_fee_plan_required")
  .refine(value => ["UNPREPARED", "READY"].includes(value.state) || Boolean(value.expenseId) && Money.of(value.remainingCost.amount, value.remainingCost.currency).amount.gt(0), "original_remaining_expense_required")
  .refine(value => value.state === "READY" ? !value.expenseId && Money.of(value.remainingCost.amount, value.remainingCost.currency).amount.isZero() : true, "zero_remaining_cost_required");
export const externalRefundFeePreparationSchema = z.object({ id, expenseId: id.nullable(), state: z.string(), idempotent: z.boolean() }).strict();
export const externalRefundAdmissionCommandSchema = z.object({ intentId: id, reviewFingerprint: hash, idempotencyKey: id }).strict();
export const externalRefundAdmissionReceiptSchema = externalRefundViewSchema.refine(value => Boolean(value.admission), "native_admission_required")
  .transform(value => ({ ...value, requestId: value.id, state: "SUCCEEDED" as const, failureCode: null }));
export const externalRefundAdmissionRecoverySchema = z.object({ request: externalRefundViewSchema.nullable() }).strict()
  .transform(({ request }) => ({ request: request?.admission ? externalRefundAdmissionReceiptSchema.parse(request) : null }));
export function acceptExternalRefund(receipt: z.infer<typeof externalRefundReceiptSchema>, input: z.infer<typeof externalRefundCommandSchema> | null, nonce: string | null) {
  return receipt.idempotencyKey === nonce && (!input || receipt.captureId === input.captureId && receipt.depositId === input.refund.depositId &&
    receipt.input.refund.accountId === input.refund.accountId && receipt.input.refund.method === input.refund.method && receipt.input.refund.purpose === input.refund.purpose && receipt.input.refund.reason === input.refund.reason && receipt.input.refund.reviewFingerprint === input.refund.reviewFingerprint &&
    Money.of(receipt.amount.amount, receipt.amount.currency).equals(Money.of(input.refund.amount, input.refund.currency)));
}
