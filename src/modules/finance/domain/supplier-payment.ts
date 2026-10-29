import { z } from "zod";

const id = z.uuid().transform(value => value.toLowerCase());
const reason = z.string().trim().min(6).max(500);
export const supplierPaymentInput = z.object({
  id, expectedVersion: z.number().int().positive(), fundingAccountId: id, idempotencyKey: id,
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).refine(value => /[1-9]/u.test(value)),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  paidAt: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  reference: z.string().trim().max(160).nullish().transform(value => value || null),
  currentPeriod: z.boolean().default(false), reason
}).strict();
export const supplierPaymentVoidInput = z.object({ id, paymentId: id, reason }).strict();
export const supplierInvoiceReversalInput = z.object({ id, expectedVersion: z.number().int().positive(), idempotencyKey: id, reason }).strict();
export const supplierSettlementQuery = z.object({ id, before: id.optional() }).strict();
