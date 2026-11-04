import { z } from "zod";
import { bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const bankStatementReviewInput = z.object({ accountId: z.uuid(), format: z.enum(["CSV", "OFX"]), fileSha256: hash, fileSize: z.number().int().positive() }).strict();
export const bankStatementImportInput = bankStatementReviewInput.extend({ idempotencyKey: z.uuid(), reviewFingerprint: hash, reason: z.string().trim().min(8).max(2000) }).strict();
export const bankStatementRecoveryInput = z.object({ idempotencyKey: z.uuid() }).strict();
export const bankStatementPolicySnapshotSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), value: bankStatementPolicySchema, input: bankStatementImportInput.optional() }).strict();
export const bankStatementFactSchema = z.object({
  externalId: z.string().min(1).max(255).nullable(),
  correction: z.object({ externalId: z.string().min(1).max(255), action: z.enum(["REPLACE", "DELETE"]) }).strict().nullable(),
  postedDate: z.iso.date().nullable(), sourceTimestamp: z.string().max(120).nullable(),
  amount: z.object({ amount: z.string().regex(/^-?(?:0|[1-9]\d{0,15})\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict().nullable(),
  name: z.string().max(2000).nullable(), memo: z.string().max(4000).nullable(), reference: z.string().max(255).nullable(), transactionType: z.string().max(40).nullable()
}).strict().superRefine((fact, context) => {
  if (fact.correction?.externalId === fact.externalId || (fact.correction?.action !== "DELETE" && (!fact.amount || !fact.postedDate)))
    context.addIssue({ code: "custom", message: "A posted bank fact must retain its amount, date and distinct correction source" });
});
export type BankStatementFact = z.infer<typeof bankStatementFactSchema>;
export type ParsedBankStatement = { statement: Record<string, unknown>; lines: { sourceOrder: number; fact: BankStatementFact }[] };
export class BankStatementAccessError extends Error { constructor() { super("bank_statement_unavailable"); } }
export class BankStatementMissingError extends BankStatementAccessError {}
export class BankStatementValidationError extends Error { constructor() { super("bank_statement_invalid_source"); } }
export class BankStatementConflictError extends Error { constructor() { super("bank_statement_conflict"); } }
export class BankStatementConfigurationError extends Error { constructor() { super("bank_statement_configuration_required"); } }
export class BankStatementStorageError extends Error { constructor() { super("bank_statement_storage_unavailable"); } }
