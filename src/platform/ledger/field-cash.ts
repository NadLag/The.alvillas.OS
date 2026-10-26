import Decimal from "decimal.js";
import { z } from "zod";

const amount = z.string().trim().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u)
  .pipe(z.string().refine(value => new Decimal(value).gt(0)));
export const fieldCashPayloadSchema = z.object({
  taskId: z.uuid(), amount, currency: z.string().regex(/^[A-Z]{3}$/u),
  payer: z.string().trim().min(1).max(240), purpose: z.string().trim().min(3).max(500),
  expectedRevision: z.string().regex(/^[a-zA-Z0-9_-]{43}$/u)
}).strict();
export type FieldCashPayload = z.infer<typeof fieldCashPayloadSchema>;
export const fieldCashConfirmSchema = z.object({
  taskId: z.uuid(), originalDeviceId: z.string().min(8).max(160), originalClientOpId: z.uuid(), receiptId: z.uuid(),
  reason: z.string().trim().min(6).max(500)
}).strict();
export type FieldCashConfirm = z.infer<typeof fieldCashConfirmSchema>;
export const fieldCashReceiptSchema = z.object({
  id: z.uuid(), amount: z.string(), currency: z.string().regex(/^[A-Z]{3}$/u),
  payer: z.string().max(240), purpose: z.string().max(500), recordedAt: z.iso.datetime()
}).strict();
export const fieldCashSnapshotSchema = z.object({
  revision: z.string().regex(/^[a-zA-Z0-9_-]{43}$/u), canCollect: z.boolean(), historyVisible: z.boolean(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/u), currencies: z.array(z.object({ code: z.string().regex(/^[A-Z]{3}$/u), minorUnit: z.number().int().min(0).max(2) }).strict()),
  receipts: z.array(fieldCashReceiptSchema).max(5)
}).strict();
export type FieldCashSnapshot = z.infer<typeof fieldCashSnapshotSchema>;
export class FieldCashConflictError extends Error {
  constructor(readonly expected: string, readonly current: string) { super("CASH_COLLECTION_CONFLICT"); this.name = "FieldCashConflictError"; }
}
export class FieldCashUnavailableError extends Error {
  constructor(readonly code: "CURRENCY_UNAVAILABLE" | "ACCOUNT_UNAVAILABLE" | "IDEMPOTENCY_KEY_REUSED" | "RECEIPT_MISMATCH") { super(code); this.name = "FieldCashUnavailableError"; }
}
