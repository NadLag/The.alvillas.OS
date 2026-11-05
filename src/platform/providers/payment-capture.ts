import { z } from "zod";
import { Money } from "@/platform/money/money";

export class PaymentCaptureEvidenceError extends Error {
  constructor(readonly status?: number) { super("payment_capture_unverified" + (status ? ":" + status : "")); }
}

const amount = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u), currency = z.string().regex(/^[A-Z]{3}$/u), identity = z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u);
const intentSchema = z.object({ amount, currency, source: identity }).strict();
const capturedOrderSchema = z.object({ id: identity, status: z.literal("COMPLETED"), purchase_units: z.array(z.object({ payments: z.object({ captures: z.array(z.object({
  id: identity, status: z.literal("COMPLETED"), amount: z.object({ value: amount, currency_code: currency }), create_time: z.iso.datetime().optional()
})).length(1) }) })).length(1) });

export function paymentCaptureIntent(raw: unknown) {
  const parsed = intentSchema.safeParse(raw); if (!parsed.success) throw new PaymentCaptureEvidenceError();
  const expected = Money.of(parsed.data.amount, parsed.data.currency); if (!expected.amount.gt(0)) throw new PaymentCaptureEvidenceError();
  return { source: parsed.data.source, ...expected.toJSON() };
}

/** The existing single-payment interface requires one completed native capture of exactly the original intended money. */
export function verifiedPayPalCapture(raw: unknown, input: ReturnType<typeof paymentCaptureIntent>) {
  const parsed = capturedOrderSchema.safeParse(raw); if (!parsed.success || parsed.data.id !== input.source) throw new PaymentCaptureEvidenceError();
  const capture = parsed.data.purchase_units[0].payments.captures[0], actual = Money.of(capture.amount.value, capture.amount.currency_code);
  if (!actual.amount.gt(0) || !actual.equals(Money.of(input.amount, input.currency))) throw new PaymentCaptureEvidenceError();
  return { paymentId: capture.id };
}
export function verifiedPayPalCaptureEvidence(raw: unknown, input: ReturnType<typeof paymentCaptureIntent>) {
  const captured = verifiedPayPalCapture(raw, input), parsed = capturedOrderSchema.parse(raw), at = parsed.purchase_units[0].payments.captures[0].create_time;
  if (!at) throw new PaymentCaptureEvidenceError();
  const envelope = z.object({ purchase_units: z.array(z.object({ payments: z.object({ captures: z.array(z.object({ seller_receivable_breakdown: z.unknown().optional() })).length(1) }) })).length(1) }).parse(raw);
  return { ...captured, capturedAt: new Date(at).toISOString(), settlement: payPalCaptureSettlement(envelope.purchase_units[0].payments.captures[0].seller_receivable_breakdown, input) };
}

const providerMoney = z.object({ value: z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u), currency_code: currency });
const canonicalProviderMoney = z.object({ amount: z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/u), currency }).strict();
export const providerCaptureSettlementSchema = z.object({ schemaVersion: z.literal(1), basis: z.literal("ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN"),
  gross: canonicalProviderMoney, fee: canonicalProviderMoney, net: canonicalProviderMoney }).strict();
export function payPalCaptureSettlement(raw: unknown, input: ReturnType<typeof paymentCaptureIntent>) {
  const parsed = z.object({ gross_amount: providerMoney, net_amount: providerMoney, paypal_fee: providerMoney.optional(), receivable_amount: providerMoney.optional() }).safeParse(raw);
  if (!parsed.success) return null;
  const { gross_amount: grossSource, net_amount: netSource, paypal_fee: reportedFee, receivable_amount: receivable } = parsed.data;
  if ([grossSource, netSource, ...reportedFee ? [reportedFee] : [], ...receivable ? [receivable] : []].some(value => value.currency_code !== input.currency)) return null;
  const gross = Money.of(grossSource.value, input.currency), net = Money.of(netSource.value, input.currency), fee = gross.subtract(net);
  if (!gross.equals(Money.of(input.amount, input.currency)) || fee.amount.lt(0) || reportedFee && !fee.equals(Money.of(reportedFee.value, input.currency)) || receivable && !net.equals(Money.of(receivable.value, input.currency))) return null;
  return providerCaptureSettlementSchema.parse({ schemaVersion: 1, basis: "ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN", gross: gross.toJSON(), fee: fee.toJSON(), net: net.toJSON() });
}

/** Read-only recovery resolves an acknowledged or lost capture before another POST. */
export function payPalOrderState(raw: unknown, input: ReturnType<typeof paymentCaptureIntent>) {
  const header = z.object({ id: identity, status: z.string() }).safeParse(raw);
  if (!header.success || header.data.id !== input.source) throw new PaymentCaptureEvidenceError();
  if (header.data.status === "COMPLETED") return { state: "CAPTURED" as const, ...verifiedPayPalCaptureEvidence(raw, input) };
  const pending = z.object({ id: identity, intent: z.literal("CAPTURE"), status: z.enum(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"]),
    purchase_units: z.array(z.object({ amount: z.object({ value: amount, currency_code: currency }) })).length(1) }).safeParse(raw);
  if (!pending.success) throw new PaymentCaptureEvidenceError();
  const total = pending.data.purchase_units[0].amount;
  if (!Money.of(total.value, total.currency_code).equals(Money.of(input.amount, input.currency))) throw new PaymentCaptureEvidenceError();
  return { state: pending.data.status === "APPROVED" ? "APPROVED" as const : "WAITING" as const };
}
