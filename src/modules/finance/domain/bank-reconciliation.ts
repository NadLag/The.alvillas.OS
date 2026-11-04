import { z } from "zod";

const uuid = z.uuid().transform(value => value.toLowerCase());
const amount = z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/u).refine(value => !/^0\.00$/u.test(value));
const allocation = z.object({ id: uuid, amount }).strict();
const selection = z.array(allocation).min(1).max(500).refine(rows => new Set(rows.map(row => row.id)).size === rows.length);
export const bankReconciliationReviewInput = z.object({
  action: z.literal("MATCH"), accountId: uuid, currency: z.string().regex(/^[A-Z]{3}$/u),
  expected: selection, actual: selection, reason: z.string().trim().min(8).max(2000),
  varianceAction: z.string().trim().min(8).max(2000).nullable()
}).strict();
export const bankReconciliationMatchInput = bankReconciliationReviewInput.extend({ idempotencyKey: uuid, reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const bankReconciliationReleaseInput = z.object({ action: z.literal("RELEASE"), id: uuid, idempotencyKey: uuid, reason: z.string().trim().min(8).max(2000) }).strict();
export const bankReconciliationRecoveryInput = z.object({ idempotencyKey: uuid }).strict();
export class BankReconciliationAccessError extends Error { constructor() { super("bank_reconciliation_unavailable"); } }
export class BankReconciliationMissingError extends BankReconciliationAccessError {}
export class BankReconciliationConflictError extends Error { constructor() { super("bank_reconciliation_conflict"); } }
export class BankReconciliationConfigurationError extends Error { constructor() { super("bank_reconciliation_configuration_required"); } }
