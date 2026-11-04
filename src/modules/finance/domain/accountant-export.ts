import { z } from "zod";
import { appLocales } from "@/i18n/routing";
import { Money } from "@/platform/money/money";

export const accountantReportKinds = ["TRANSACTIONS", "INCOME", "EXPENSES", "OWNER_STATEMENTS", "BANK_RECONCILIATION", "SUPPLIER_PAYMENTS", "STAFF_PAYMENTS"] as const;
export const accountantExportFormats = ["CSV", "EXCEL", "PDF"] as const;
export const accountantExportInputSchema = z.object({ kind: z.enum(accountantReportKinds), format: z.enum(accountantExportFormats),
  locale: z.enum(appLocales), fromOn: z.iso.date(), toOn: z.iso.date(), currency: z.string().regex(/^[A-Z]{3}$/u),
  propertyId: z.uuid().transform(value => value.toLowerCase()).optional(), ownerId: z.uuid().transform(value => value.toLowerCase()).optional(),
  accountId: z.uuid().transform(value => value.toLowerCase()).optional(),
  reason: z.string().trim().min(6).max(1000) }).strict().refine(value => value.fromOn <= value.toOn, { path: ["toOn"], message: "invalid_range" })
  .refine(value => value.kind === "OWNER_STATEMENTS" ? value.ownerId !== undefined : value.ownerId === undefined, { path: ["ownerId"], message: "explicit_owner_statement_required" })
  .refine(value => value.accountId === undefined || value.kind === "BANK_RECONCILIATION", { path: ["accountId"], message: "bank_account_filter_required" })
  .refine(value => !["BANK_RECONCILIATION", "SUPPLIER_PAYMENTS", "STAFF_PAYMENTS"].includes(value.kind) || value.propertyId === undefined, { path: ["propertyId"], message: "source_has_no_inferred_property" });
export class AccountantExportAccessError extends Error { constructor() { super("accountant_export_forbidden"); } }
export class AccountantExportConfigurationError extends Error { constructor() { super("accountant_export_configuration_unavailable"); } }
export class AccountantExportSourceError extends Error { constructor() { super("accountant_export_source_unavailable"); } }
export class AccountantExportChangedError extends Error { constructor() { super("accountant_export_source_changed"); } }
export class AccountantExportCapacityError extends Error { constructor() { super("accountant_export_capacity_exceeded"); } }
export class AccountantExportRateLimitError extends Error { constructor(readonly resetAt: Date) { super("accountant_export_rate_limited"); } }

export const accountantExportColumns = ["recordType", "sourceId", "transactionId", "postingId", "reference", "occurredAt", "description", "currency",
  "accountId", "accountCode", "accountType", "normalSide", "side", "amount", "bucket", "propertyId", "ownerId", "supplierId", "invoiceId",
  "personId", "claimId", "reversesTransactionId", "opening", "debits", "credits", "closing", "expected", "actual", "variance", "state",
  "statementLineId", "reconciliationId", "releaseId", "postedOn", "allocated", "remaining", "paidAt", "paymentReference", "recognitionId", "submissionId", "invoiceNumber", "counterparty"] as const;
export type AccountantExportColumn = typeof accountantExportColumns[number];
export type AccountantReportKind = typeof accountantReportKinds[number];
export type AccountantExportFormat = typeof accountantExportFormats[number];
const moneyColumns = new Set<AccountantExportColumn>(["amount", "opening", "debits", "credits", "closing", "expected", "actual", "variance", "allocated", "remaining"]);
const identifierColumns = new Set<AccountantExportColumn>(["sourceId", "transactionId", "postingId", "accountId", "propertyId", "ownerId", "supplierId", "invoiceId", "personId", "claimId", "reversesTransactionId", "statementLineId", "reconciliationId", "releaseId", "recognitionId", "submissionId"]);
export type AccountantExportCell = { kind: "TEXT" | "IDENTIFIER" | "TIMESTAMP" | "MONEY" | "DATE"; value: string | null };
export type AccountantExportRow = { identity: string; cells: Partial<Record<AccountantExportColumn, AccountantExportCell>> };
export type AccountantExportDocument = { organizationId: string; kind: AccountantReportKind; currency: string; fromOn: string; toOn: string;
  scope: { propertyId: string | null; ownerId: string | null; accountId: string | null };
  timezone: string; policy: { id: string; version: number }; sourceFingerprint: string; generatedAt: string; columns: AccountantExportColumn[]; rows: AccountantExportRow[] };
export type AccountantExportNativeSnapshot = { columns: AccountantExportColumn[]; rows: AccountantExportRow[]; fingerprint: string };
export type AccountantExportInput = z.infer<typeof accountantExportInputSchema>;

function columnKind(column: AccountantExportColumn): AccountantExportCell["kind"] {
  return moneyColumns.has(column) ? "MONEY" : identifierColumns.has(column) ? "IDENTIFIER" : column === "occurredAt" || column === "paidAt" ? "TIMESTAMP" : column === "postedOn" ? "DATE" : "TEXT";
}
export function accountantExportRow(identity: string, columns: readonly AccountantExportColumn[], values: Readonly<Record<string, string | null>>): AccountantExportRow {
  if (columns.some(column => !Object.hasOwn(values, column))) throw new AccountantExportSourceError();
  return { identity, cells: Object.fromEntries(columns.map(column => [column, { kind: columnKind(column), value: values[column] }])) };
}

const cell = z.object({ kind: z.enum(["TEXT", "IDENTIFIER", "TIMESTAMP", "MONEY", "DATE"]), value: z.string().max(10000).nullable() }).strict();
const documentSchema = z.object({ organizationId: z.uuid(), kind: z.enum(accountantReportKinds), currency: z.string().regex(/^[A-Z]{3}$/u),
  scope: z.object({ propertyId: z.uuid().nullable(), ownerId: z.uuid().nullable(), accountId: z.uuid().nullable() }).strict().default({ propertyId: null, ownerId: null, accountId: null }),
  fromOn: z.iso.date(), toOn: z.iso.date(), timezone: z.string().min(1).max(120), policy: z.object({ id: z.uuid(), version: z.number().int().positive() }).strict(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), generatedAt: z.iso.datetime({ offset: true }),
  columns: z.array(z.enum(accountantExportColumns)).min(1).max(accountantExportColumns.length),
  rows: z.array(z.object({ identity: z.string().min(1).max(500), cells: z.partialRecord(z.enum(accountantExportColumns), cell) }).strict()) }).strict();

/** Every renderer consumes the complete same-source document. Money remains a decimal string in every format. */
export function validateAccountantExportDocument(raw: unknown, maxRows: number): AccountantExportDocument {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new AccountantExportConfigurationError();
  const parsed = documentSchema.safeParse(raw); if (!parsed.success) throw new AccountantExportSourceError();
  const source = parsed.data;
  if (source.fromOn > source.toOn || new Set(source.columns).size !== source.columns.length) throw new AccountantExportSourceError();
  if (source.rows.length > maxRows) throw new AccountantExportCapacityError();
  try { new Intl.DateTimeFormat("en", { timeZone: source.timezone }); } catch { throw new AccountantExportConfigurationError(); }
  const identities = new Set<string>();
  for (const row of source.rows) {
    if (identities.has(row.identity)) throw new AccountantExportSourceError(); identities.add(row.identity);
    if (Object.keys(row.cells).some(key => !source.columns.includes(key as AccountantExportColumn))) throw new AccountantExportSourceError();
    for (const column of source.columns) {
      const item = row.cells[column], expected = columnKind(column);
      if (!item || item.kind !== expected) throw new AccountantExportSourceError();
      if (item.value === null) continue;
      if (item.kind === "IDENTIFIER" && !z.uuid().safeParse(item.value).success || item.kind === "TIMESTAMP" && !z.iso.datetime({ offset: true }).safeParse(item.value).success) throw new AccountantExportSourceError();
      if (item.kind === "DATE" && !z.iso.date().safeParse(item.value).success) throw new AccountantExportSourceError();
      if (item.kind === "MONEY") {
        if (!/^-?(?:0|[1-9]\d*)\.\d{2}$/u.test(item.value)) throw new AccountantExportSourceError();
        try { if (Money.of(item.value, source.currency).toJSON().amount !== item.value) throw new AccountantExportSourceError(); }
        catch { throw new AccountantExportSourceError(); }
      }
    }
  }
  return source;
}
