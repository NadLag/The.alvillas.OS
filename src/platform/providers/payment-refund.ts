import { z } from "zod";
import { Money } from "@/platform/money/money";
import { paymentCaptureIntent } from "./payment-capture";
import { payPalRefundSettlement, providerRefundSettlementSchema } from "./payment-refund-settlement";

export class PaymentRefundEvidenceError extends Error {
  constructor(readonly status?: number) { super("payment_refund_unverified" + (status ? ":" + status : "")); }
}

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u);
const intentSchema = z.object({ captureId: identity, requestId: z.uuid(), amount: z.string(), currency: z.string() }).strict();
const providerMoney = z.object({ value: z.string(), currency_code: z.string() });
export const providerRefundEvidenceSchema = z.object({ refundId: identity, captureId: identity, requestId: z.uuid(),
  amount: z.object({ amount: z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict(),
  state: z.enum(["PENDING", "COMPLETED", "FAILED", "CANCELLED"]), createdAt: z.iso.datetime({ precision: 3 }), updatedAt: z.iso.datetime({ precision: 3 }), refundedAt: z.iso.datetime({ precision: 3 }).nullable()
}).strict().refine(value => value.updatedAt >= value.createdAt && (value.state === "COMPLETED" ? value.refundedAt === value.updatedAt : value.refundedAt === null));
export const providerRefundResultSchema = providerRefundEvidenceSchema.safeExtend({ settlement: providerRefundSettlementSchema.nullable() });
const refundSchema = z.object({ id: identity, custom_id: z.string(), status: z.enum(["PENDING", "COMPLETED", "FAILED", "CANCELLED"]),
  amount: providerMoney, create_time: z.iso.datetime({ offset: true }), update_time: z.iso.datetime({ offset: true }),
  links: z.array(z.object({ rel: z.string(), href: z.string(), method: z.string().optional() })) });

/** A refund always names an original capture and an explicit amount, including a full refund. */
export function paymentRefundIntent(raw: unknown) {
  const parsed = intentSchema.safeParse(raw); if (!parsed.success) throw new PaymentRefundEvidenceError();
  try {
    const money = paymentCaptureIntent({ source: parsed.data.captureId, amount: parsed.data.amount, currency: parsed.data.currency });
    return { captureId: parsed.data.captureId, requestId: parsed.data.requestId.toLowerCase(), amount: money.amount, currency: money.currency };
  } catch { throw new PaymentRefundEvidenceError(); }
}

/** Provider links are evidence only. Never follow response-controlled URLs with credentials. */
export function verifiedPayPalRefund(raw: unknown, input: ReturnType<typeof paymentRefundIntent>, apiBaseUrl: string, refundId?: string) {
  const parsed = refundSchema.safeParse(raw); if (!parsed.success) throw new PaymentRefundEvidenceError();
  const refund = parsed.data;
  try {
    const base = new URL(apiBaseUrl), parents = refund.links.filter(link => link.rel === "up");
    if (parents.length !== 1) throw new PaymentRefundEvidenceError();
    const parent = new URL(parents[0].href), expectedPath = base.pathname.replace(/\/$/u, "") + "/v2/payments/captures/" + encodeURIComponent(input.captureId);
    if (parent.origin !== base.origin || parent.pathname !== expectedPath || parent.username || parent.password || parent.search || parent.hash || parents[0].method && parents[0].method !== "GET") throw new PaymentRefundEvidenceError();
    if (refund.custom_id !== input.requestId || refundId && refund.id !== refundId || !Money.of(refund.amount.value, refund.amount.currency_code).equals(Money.of(input.amount, input.currency))) throw new PaymentRefundEvidenceError();
    // Validate provider precision and notation before accepting Money's normalized representation.
    paymentCaptureIntent({ source: input.captureId, amount: refund.amount.value, currency: refund.amount.currency_code });
    const createdAt = new Date(refund.create_time), updatedAt = new Date(refund.update_time);
    if (updatedAt < createdAt) throw new PaymentRefundEvidenceError();
    return providerRefundEvidenceSchema.parse({ refundId: refund.id, captureId: input.captureId, requestId: input.requestId, amount: Money.of(input.amount, input.currency).toJSON(),
      state: refund.status, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(), refundedAt: refund.status === "COMPLETED" ? updatedAt.toISOString() : null });
  } catch { throw new PaymentRefundEvidenceError(); }
}

export function paymentRefundLookup(raw: unknown) {
  const parsed = z.object({ intent: z.unknown(), refundId: identity }).strict().safeParse(raw);
  if (!parsed.success) throw new PaymentRefundEvidenceError();
  return { intent: paymentRefundIntent(parsed.data.intent), refundId: parsed.data.refundId };
}

export function verifiedPayPalRefundResult(raw: unknown, input: ReturnType<typeof paymentRefundIntent>, apiBaseUrl: string, refundId?: string) {
  const evidence = verifiedPayPalRefund(raw, input, apiBaseUrl, refundId), envelope = z.object({ seller_payable_breakdown: z.unknown().optional() }).safeParse(raw);
  if (!envelope.success) throw new PaymentRefundEvidenceError();
  return { ...evidence, settlement: payPalRefundSettlement(envelope.data.seller_payable_breakdown, input) };
}
