import type { TenantTransactionRunner } from "@/platform/db/tenant";
import { accountantExportInputSchema } from "../domain/accountant-export";
import { renderAccountantCsv, renderAccountantExcel, type AccountantExportLabels } from "../infrastructure/accountant-tabular-renderer";
import { configuredAccountantPdfRenderer, accountantPdfTemplate } from "../infrastructure/accountant-pdf-renderer";
import { prepareAccountantExport } from "./accountant-export-service";
import type { FinanceActorContext } from "./finance-access";
export type { AccountantExportLabels } from "../infrastructure/accountant-tabular-renderer";

/** Format adapters stay behind the application boundary and the original export service's commit fence. */
export async function exportAccountantFile(actor: FinanceActorContext, raw: unknown, labels: AccountantExportLabels,
  deps: { db: TenantTransactionRunner; requestId?: string }) {
  const input = accountantExportInputSchema.parse(raw);
  return prepareAccountantExport(actor, input, async (source, maxRows) => input.format === "CSV" ? renderAccountantCsv(source, labels, maxRows)
    : input.format === "EXCEL" ? renderAccountantExcel(source, labels, input.locale, maxRows)
    : configuredAccountantPdfRenderer().render({ template: accountantPdfTemplate, locale: input.locale, data: { source, labels, maxRows } }), deps);
}
