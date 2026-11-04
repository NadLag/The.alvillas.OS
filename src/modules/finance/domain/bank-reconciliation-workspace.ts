import { z } from "zod";
import { bankStatementFactSchema } from "./bank-statement";
import { bankReconciliationPlanSchema, bankReconciliationStateSchema, bankReconciliationResultSchema } from "./bank-reconciliation-command";

const account = { accountId: z.uuid(), currency: z.string().regex(/^[A-Z]{3}$/u), after: z.uuid().optional() };
export const bankReconciliationWorkspaceInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("SOURCES"), ...account }).strict(),
  z.object({ operation: z.literal("POSTINGS"), ...account, lineId: z.uuid().optional() }).strict(),
  z.object({ operation: z.literal("HISTORY"), accountId: z.uuid(), before: z.uuid().optional() }).strict(),
  z.object({ operation: z.literal("DETAIL"), id: z.uuid() }).strict()
]);
const money = z.object({ amount: z.string(), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict();
export const bankReconciliationSourcesSchema = z.object({ canReconcile: z.boolean(), items: z.array(z.object({ id: z.uuid(), fact: bankStatementFactSchema,
  state: z.enum(["ACTIVE", "SUPERSEDED", "REMOVED", "UNRESOLVED", "AMBIGUOUS"]), allocated: money, remaining: money, eligible: z.boolean() }).strict()), next: z.uuid().nullable() }).strict();
export const bankReconciliationPostingsSchema = z.object({ items: z.array(z.object({ id: z.uuid(), transactionId: z.uuid(), reference: z.string(), occurredAt: z.iso.datetime(),
  original: money, allocated: money, remaining: money, suggested: z.boolean(), canReconcile: z.boolean() }).strict()), next: z.uuid().nullable(),
  matching: z.object({ dateWindowDays: z.number().int().nonnegative(), amountTolerance: z.string(), reference: z.enum(["EXACT", "CASE_INSENSITIVE", "NONE"]), timezone: z.string() }).strict().nullable() }).strict();
export const bankReconciliationHistorySchema = z.object({ items: z.array(z.object({ id: z.uuid(), action: z.enum(["MATCH", "RELEASE"]), previousId: z.uuid().nullable(), createdAt: z.iso.datetime(),
  state: bankReconciliationStateSchema, currency: z.string().regex(/^[A-Z]{3}$/u), reason: z.string(), plan: bankReconciliationPlanSchema }).strict()), next: z.uuid().nullable() }).strict();
export const bankReconciliationReviewSchema = z.object({ reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), plan: bankReconciliationPlanSchema }).strict();
export const bankReconciliationDetailSchema = bankReconciliationResultSchema.extend({ canRelease: z.boolean() }).strict();
