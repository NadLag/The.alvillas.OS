import { z } from "zod";
import { bankStatementFactSchema, bankStatementCurrencyEvidenceSchema } from "./bank-statement";

export const bankStatementWorkspaceInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ACCOUNTS") }).strict(),
  z.object({ operation: z.literal("LIST"), accountId: z.uuid(), before: z.uuid().optional() }).strict(),
  z.object({ operation: z.literal("DETAIL"), importId: z.uuid(), afterOrder: z.number().int().nonnegative().max(5000).optional() }).strict()
]);
export const bankStatementAccountSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string(), currency: z.string().regex(/^[A-Z]{3}$/u),
  statementCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/u)).refine(values => new Set(values).size === values.length).default([]),
  lastFour: z.string(), formats: z.array(z.enum(["CSV", "OFX"])), maxBytes: z.number().int().positive(), canImport: z.boolean() }).strict();
export const bankStatementAccountsSchema = z.object({ items: z.array(bankStatementAccountSchema) }).strict();
export const bankStatementImportSummarySchema = z.object({ id: z.uuid(), admissionId: z.uuid(), accountId: z.uuid(), format: z.enum(["CSV", "OFX"]), fileSha256: z.string().regex(/^[a-f0-9]{64}$/u), fileSize: z.number().int().positive(), rowCount: z.number().int().nonnegative(), newRows: z.number().int().nonnegative(), reusedRows: z.number().int().nonnegative(), importedAt: z.iso.datetime(), reason: z.string() }).strict();
export const bankStatementListSchema = z.object({ items: z.array(bankStatementImportSummarySchema), next: z.uuid().nullable() }).strict();
export const bankStatementDetailSchema = z.object({ source: bankStatementImportSummarySchema, account: bankStatementAccountSchema,
  lines: z.array(z.object({ id: z.uuid(), sourceOrder: z.number().int().positive(), fact: bankStatementFactSchema, currencyEvidence: bankStatementCurrencyEvidenceSchema.optional() }).strict()), nextOrder: z.number().int().positive().nullable() }).strict();
export const bankStatementReviewSchema = z.object({ reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), rowCount: z.number().int().nonnegative(), newRows: z.number().int().nonnegative(), reusedRows: z.number().int().nonnegative(),
  account: z.object({ id: z.uuid(), name: z.string(), code: z.string(), lastFour: z.string() }).strict(), statement: z.record(z.string(), z.unknown()),
  lines: z.array(z.object({ sourceOrder: z.number().int().positive(), fact: bankStatementFactSchema, currencyEvidence: bankStatementCurrencyEvidenceSchema.optional() }).strict()) }).strict();
