import { z } from "zod";

const uuid = z.uuid().transform(value => value.toLowerCase());
const amount = z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/u).refine(value => !/^0\.00$/u.test(value));
const allocation = z.object({ id: uuid, amount }).strict();
const selection = z.array(allocation).min(1).max(500).refine(rows => new Set(rows.map(row => row.id)).size === rows.length);
const actualSelection = z.array(allocation).max(500).refine(rows => new Set(rows.map(row => row.id)).size === rows.length);
const bankReconciliationReviewObject = z.object({
  action: z.literal("MATCH"), accountId: uuid, currency: z.string().regex(/^[A-Z]{3}$/u),
  expected: selection, actual: actualSelection, reason: z.string().trim().min(8).max(2000),
  varianceAction: z.string().trim().min(8).max(2000).nullable(),
  evidence: z.array(uuid).min(1).max(500).refine(ids => new Set(ids).size === ids.length).optional()
}).strict();
function validateActualEvidence(value: { actual: unknown[]; evidence?: string[] }, context: z.RefinementCtx) {
  if (value.actual.length === 0 ? !value.evidence?.length : value.evidence !== undefined)
    context.addIssue({ code: "custom", message: "Choose original movements or retained removal evidence" });
}
export const bankReconciliationReviewInput = bankReconciliationReviewObject.superRefine(validateActualEvidence);
export const bankReconciliationMatchInput = bankReconciliationReviewObject.extend({ idempotencyKey: uuid, reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().superRefine(validateActualEvidence);
export const bankReconciliationReleaseInput = z.object({ action: z.literal("RELEASE"), id: uuid, idempotencyKey: uuid, reason: z.string().trim().min(8).max(2000) }).strict();
export const bankReconciliationRecoveryInput = z.object({ idempotencyKey: uuid }).strict();
export class BankReconciliationAccessError extends Error { constructor() { super("bank_reconciliation_unavailable"); } }
export class BankReconciliationMissingError extends BankReconciliationAccessError {}
export class BankReconciliationConflictError extends Error { constructor() { super("bank_reconciliation_conflict"); } }
export class BankReconciliationConfigurationError extends Error { constructor() { super("bank_reconciliation_configuration_required"); } }
