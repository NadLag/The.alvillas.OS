import type { AppLocale } from "@/i18n/routing";
import { z } from "zod";
import { spreadsheetCsvCell } from "@/platform/exports/spreadsheet-cell";
import { accountantExportColumns, validateAccountantExportDocument, type AccountantExportColumn, type AccountantExportDocument } from "../domain/accountant-export";

const metadataKeys = ["report", "fromOn", "toOn", "currency", "timezone", "policyId", "policyVersion", "sourceFingerprint", "generatedAt", "propertyId", "ownerId", "accountId"] as const;
export type AccountantExportLabels = { title: string; headers: Record<AccountantExportColumn, string>;
  metadata: Record<typeof metadataKeys[number] | "recordType", string>; metadataRow: string; sourceRow: string; metadataSheet: string; dataSheet: string };
export const accountantExportLabelsSchema = z.object({ title: z.string().min(1).max(500), headers: z.record(z.enum(accountantExportColumns), z.string().min(1).max(500)),
  metadata: z.record(z.enum([...metadataKeys, "recordType"]), z.string().min(1).max(500)), metadataRow: z.string().min(1).max(100), sourceRow: z.string().min(1).max(100),
  metadataSheet: z.string().min(1).max(31).regex(/^[^\\/?*[\]:]+$/u), dataSheet: z.string().min(1).max(31).regex(/^[^\\/?*[\]:]+$/u) }).strict();

const metadataValues = (document: AccountantExportDocument, labels: AccountantExportLabels) => [labels.title, document.fromOn, document.toOn,
  document.currency, document.timezone, document.policy.id, String(document.policy.version), document.sourceFingerprint, document.generatedAt,
  document.scope.propertyId ?? "", document.scope.ownerId ?? "", document.scope.accountId ?? ""];

/** A metadata record survives an empty report; all records share the same complete CSV column catalog. */
export function renderAccountantCsv(raw: unknown, labels: AccountantExportLabels, maxRows: number): Uint8Array {
  const document = validateAccountantExportDocument(raw, maxRows), metadata = metadataValues(document, labels);
  const line = (values: string[], numeric = new Set<number>()) => values.map((value, index) => spreadsheetCsvCell(value, numeric.has(index))).join(",") + "\r\n";
  const records = [line([labels.metadata.recordType, ...metadataKeys.map(key => labels.metadata[key]), ...document.columns.map(column => labels.headers[column])]),
    line([labels.metadataRow, ...metadata, ...document.columns.map(() => "")])];
  for (const row of document.rows) {
    const numeric = new Set(document.columns.flatMap((column, index) => row.cells[column]?.kind === "MONEY" && row.cells[column]?.value !== null ? [index + metadata.length + 1] : []));
    records.push(line([labels.sourceRow, ...metadata, ...document.columns.map(column => row.cells[column]!.value ?? "")], numeric));
  }
  return new TextEncoder().encode("\uFEFF" + records.join(""));
}

/** Typed string cells preserve arbitrary-precision decimals and never create formulas, links or external data sources. */
export async function renderAccountantExcel(raw: unknown, labels: AccountantExportLabels, locale: AppLocale, maxRows: number): Promise<Uint8Array> {
  const document = validateAccountantExportDocument(raw, maxRows), { default: writeExcelFile } = await import("write-excel-file/node");
  const header = (value: string) => ({ type: String, value, fontWeight: "bold" as const, backgroundColor: "#0B6B5F", textColor: "#FFFFFF", wrap: true });
  const metadata = metadataValues(document, labels), data = [document.columns.map(column => header(labels.headers[column])),
    ...document.rows.map(row => document.columns.map(column => ({ type: String, value: row.cells[column]!.value ?? "", wrap: true })))];
  const buffer = await writeExcelFile([
    { sheet: labels.metadataSheet, data: metadataKeys.map((key, index) => [header(labels.metadata[key]), { type: String, value: metadata[index], wrap: true }]),
      columns: [{ width: 25 }, { width: 80 }], rightToLeft: locale === "ar", orientation: "landscape" },
    { sheet: labels.dataSheet, data, columns: document.columns.map(column => ({ width: column === "description" ? 50 : 28 })),
      rightToLeft: locale === "ar", orientation: "landscape", stickyRowsCount: 1, showGridLines: false }
  ], { fontFamily: "Source Sans 3", fontSize: 11 }).toBuffer();
  return new Uint8Array(buffer);
}
