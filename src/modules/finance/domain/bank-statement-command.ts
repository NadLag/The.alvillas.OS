import { z } from "zod";
import { bankStatementImportInput } from "./bank-statement";
const base = { requestId: z.uuid(), idempotencyKey: z.uuid(), operation: z.literal("IMPORT"), failureCode: z.null() };
export const bankStatementCommandReceiptSchema = z.discriminatedUnion("state", [
  z.object({ ...base, state: z.literal("SUCCEEDED"), accountId: z.uuid(), importId: z.uuid(), rowCount: z.number().int().nonnegative(), newRows: z.number().int().nonnegative(), reusedRows: z.number().int().nonnegative() }).strict(),
  z.object({ ...base, state: z.literal("PENDING"), resumeInput: bankStatementImportInput }).strict()
]);
export const bankStatementCommandRecoverySchema = z.object({ request: bankStatementCommandReceiptSchema.nullable() }).strict();
export type BankStatementCommandReceipt = z.infer<typeof bankStatementCommandReceiptSchema>;
