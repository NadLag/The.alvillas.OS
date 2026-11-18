import type { TenantTransactionRunner } from "@/platform/db/tenant";
import type { AppLocale } from "@/i18n/routing";
import { accountantExportInputSchema, type AccountantExportDocument, type AccountantExportFormat } from "../domain/accountant-export";
import { renderAccountantCsv, renderAccountantExcel, type AccountantExportLabels } from "../infrastructure/accountant-tabular-renderer";
import { configuredAccountantPdfRenderer, accountantPdfTemplate } from "../infrastructure/accountant-pdf-renderer";
import { prepareAccountantExport } from "./accountant-export-service";
import type { FinanceActorContext } from "./finance-access";
export type { AccountantExportLabels } from "../infrastructure/accountant-tabular-renderer";

/** Format adapters stay behind the application boundary and the original export service's commit fence. */
export async function exportAccountantFile(actor: FinanceActorContext, raw: unknown, labels: AccountantExportLabels,
  deps: { db: TenantTransactionRunner; requestId?: string }) {
  const input = accountantExportInputSchema.parse(raw);
  return prepareAccountantExport(actor, input, (source, maxRows) =>
    renderAccountantReportDocument(source, input.format, input.locale, labels, maxRows), deps);
}

export function renderAccountantReportDocument(source: AccountantExportDocument, format: AccountantExportFormat,
  locale: AppLocale, labels: AccountantExportLabels, maxRows: number) {
  if (format === "CSV") return renderAccountantCsv(source, labels, maxRows);
  if (format === "EXCEL") return renderAccountantExcel(source, labels, locale, maxRows);
  return configuredAccountantPdfRenderer().render({ template: accountantPdfTemplate, locale, data: { source, labels, maxRows } });
}
