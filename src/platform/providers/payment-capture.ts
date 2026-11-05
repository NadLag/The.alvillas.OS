import { z } from "zod";
import { Money } from "@/platform/money/money";

export class PaymentCaptureEvidenceError extends Error {
  constructor(readonly status?: number) { super("payment_capture_unverified" + (status ? ":" + status : "")); }
}

const amount = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u), currency = z.string().regex(/^[A-Z]{3}$/u), identity = z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u);
const intentSchema = z.object({ amount, currency, source: identity }).strict();
const capturedOrderSchema = z.object({ id: identity, status: z.literal("COMPLETED"), purchase_units: z.array(z.object({ payments: z.object({ captures: z.array(z.object({
  id: identity, status: z.literal("COMPLETED"), amount: z.object({ value: amount, currency_code: currency })
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
