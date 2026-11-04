import { z } from "zod";

const column = z.string().min(1).max(120).refine(value => value === value.trim().toLowerCase().replace(/[\s-]+/gu, "_"));
const columns = z.object({ postedDate: column, transactionId: column.nullable(), reference: column.nullable(), description: column, currency: column.nullable() });
export const bankCsvMappingSchema = z.object({
  delimiter: z.enum([",", ";", "\t"]),
  dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]),
  decimalSeparator: z.enum([".", ","]),
  groupingSeparator: z.enum(["", ".", ",", " ", "\u00a0", "\u202f"]),
  columns: z.union([columns.extend({ amount: column }).strict(), columns.extend({ debit: column, credit: column }).strict()])
}).strict().superRefine((value, context) => {
  if (value.decimalSeparator === value.groupingSeparator) context.addIssue({ code: "custom", message: "Decimal and grouping separators must differ" });
  const mapped = Object.values(value.columns).filter(value => value !== null);
  if (new Set(mapped).size !== mapped.length) context.addIssue({ code: "custom", message: "Source columns must be independent" });
});

/** Every bank account identity, parser mapping and matching tolerance is explicitly configured. */
export const bankStatementPolicyKey = "finance.bank_statements";
export const bankStatementPolicySchema = z.object({
  source: z.literal("ORIGINAL_BANK_STATEMENT"),
  accounts: z.array(z.object({
    account_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/u),
    bank_id: z.string().min(1).max(255),
    branch_id: z.string().min(1).max(255).nullable(),
    account_id: z.string().min(1).max(255),
    account_type: z.string().min(1).max(40),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    csv: bankCsvMappingSchema.nullable(),
    ofx: z.boolean()
  }).strict()).min(1).refine(accounts => new Set(accounts.map(account => account.account_code)).size === accounts.length, "Account codes must be unique")
    .refine(accounts => new Set(accounts.map(account => JSON.stringify([account.bank_id, account.branch_id, account.account_id]))).size === accounts.length, "Actual bank identities must be unique"),
  encoding: z.enum(["UTF-8", "WINDOWS-1252"]),
  max_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
  max_rows: z.number().int().min(1).max(5000),
  matching: z.object({
    date_window_days: z.number().int().min(0).max(366),
    amount_tolerance: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u),
    reference: z.enum(["EXACT", "CASE_INSENSITIVE", "NONE"]),
    admission: z.literal("EXPLICIT_REVIEW"),
    ledger_effect: z.literal("NONE")
  }).strict(),
  source_corrections: z.literal("APPEND_AND_REOPEN_REVIEW"),
  duplicate_csv_without_id: z.literal("RETAIN_EVERY_ROW")
}).strict();
export type BankStatementPolicy = z.infer<typeof bankStatementPolicySchema>;
