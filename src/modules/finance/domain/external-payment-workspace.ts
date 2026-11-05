import { z } from "zod";
import { Money } from "@/platform/money/money";
import { providerCaptureSettlementSchema } from "@/platform/providers/payment-capture";
import { externalPaymentIntentInput, externalPaymentReviewInput, capturedPayPalAdmissionInput } from "./external-payment-command";
import { paymentMethodSchema } from "./payment-method";

const id = z.uuid(), instant = z.iso.datetime(), hash = z.string().regex(/^[a-f0-9]{64}$/u), money = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict();
export const externalPaymentIntentViewSchema = z.object({ id, idempotencyKey: id, orderId: externalPaymentIntentInput.shape.orderId, amount: money,
  state: z.enum(["PENDING", "CAPTURED"]), captureId: id.nullable(), capturedAt: instant.nullable(), observedAt: instant.nullable(), settlement: providerCaptureSettlementSchema.nullable(), idempotent: z.boolean(),
  admission: z.object({ state: z.literal("ADMITTED"), transactionId: id, depositId: id, reversed: z.boolean() }).strict().nullable().default(null),
}).strict().refine(value => !value.settlement || Money.of(value.amount.amount, value.amount.currency).equals(Money.of(value.settlement.gross.amount, value.settlement.gross.currency)) &&
  value.settlement.fee.currency === value.amount.currency && value.settlement.net.currency === value.amount.currency &&
  Money.of(value.settlement.fee.amount, value.amount.currency).add(Money.of(value.settlement.net.amount, value.amount.currency)).equals(Money.of(value.amount.amount, value.amount.currency)), "actual_settlement_conservation_required")
  .refine(value => value.state === "PENDING" ? !value.captureId && !value.capturedAt && !value.observedAt && !value.settlement && !value.admission :
  Boolean(value.captureId && value.capturedAt && value.observedAt && (!value.admission || value.admission.depositId === value.idempotencyKey)), "actual_original_capture_required");
export const externalCaptureReceiptSchema = externalPaymentIntentViewSchema.transform(value => ({ ...value, sourceState: value.state, requestId: value.id,
  state: value.state === "CAPTURED" ? "SUCCEEDED" as const : "PENDING" as const, failureCode: null }));
export const externalCaptureRecoverySchema = z.object({ request: externalPaymentIntentViewSchema.nullable() }).strict().transform(value => ({ request: value.request ? externalCaptureReceiptSchema.parse(value.request) : null }));
export const externalCaptureCommandSchema = externalPaymentReviewInput.extend({ idempotencyKey: id,
  receipt: externalPaymentIntentInput.shape.receipt.omit({ idempotencyKey: true }) }).strict();
export const externalCaptureReviewSchema = z.object({ reservationId: id, amount: money, account: z.object({ id, name: z.string() }).strict(),
  method: paymentMethodSchema, receivedAt: instant, reviewFingerprint: hash, paymentMethodFingerprint: hash }).strict();
export const externalAdmissionReviewSchema = externalCaptureReviewSchema.extend({ intentId: id, captureId: id, purpose: z.string(), orderId: externalPaymentIntentInput.shape.orderId,
  settlement: providerCaptureSettlementSchema.nullable(), fee: z.object({ id, version: z.number().int().positive(), state: z.string() }).strict().nullable() }).strict();
export const externalAdmissionCommandSchema = capturedPayPalAdmissionInput.extend({ idempotencyKey: id }).strict();
export const externalAdmissionReceiptSchema = z.object({ id, depositId: id, operation: z.literal("RECEIPT"), idempotent: z.boolean() }).strict().transform(value =>
  ({ ...value, idempotencyKey: value.depositId, requestId: value.id, state: "SUCCEEDED" as const, failureCode: null }));
export const externalAdmissionRecoverySchema = z.object({ request: externalPaymentIntentViewSchema.nullable() }).strict().transform(({ request }) => ({ request: request?.admission ?
  externalAdmissionReceiptSchema.parse({ id: request.admission.transactionId, depositId: request.admission.depositId, operation: "RECEIPT", idempotent: true }) : null }));
export function acceptExternalCapture(receipt: z.infer<typeof externalCaptureReceiptSchema>, input: z.infer<typeof externalCaptureCommandSchema> | null, nonce: string | null) {
  return nonce === receipt.idempotencyKey && (!input || input.orderId === receipt.orderId && Money.of(input.receipt.amount, input.receipt.currency).equals(Money.of(receipt.amount.amount, receipt.amount.currency)));
}
