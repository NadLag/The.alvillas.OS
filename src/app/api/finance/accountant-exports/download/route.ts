import type { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { exportAccountantFile, type AccountantExportLabels } from "@/modules/finance/application/accountant-file-export";
import { accountantExportColumns, accountantExportInputSchema } from "@/modules/finance/domain/accountant-export";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return compensationHttp(request, async (actor, raw, requestId) => {
    const input = accountantExportInputSchema.parse(raw), t = await getTranslations({ locale: input.locale, namespace: "AccountantExports" });
    const metadataKeys = ["recordType", "report", "fromOn", "toOn", "currency", "timezone", "policyId", "policyVersion", "sourceFingerprint", "generatedAt", "propertyId", "ownerId", "accountId"] as const;
    const labels: AccountantExportLabels = { title: t(`reports.${input.kind}`), headers: Object.fromEntries(accountantExportColumns.map(key => [key, t(`columns.${key}`)])) as AccountantExportLabels["headers"],
      metadata: Object.fromEntries(metadataKeys.map(key => [key, t(`metadata.${key}`)])) as AccountantExportLabels["metadata"],
      metadataRow: t("metadataRow"), sourceRow: t("sourceRow"), metadataSheet: t("metadataSheet"), dataSheet: t("dataSheet") };
    const bytes = await exportAccountantFile(actor, input, labels, { db: prisma, requestId });
    const extension = input.format === "EXCEL" ? "xlsx" : input.format.toLowerCase(), contentType = input.format === "CSV" ? "text/csv; charset=utf-8" : input.format === "EXCEL" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
    return { bytes, contentType, requestId, fileName: `accountant-${input.kind.toLowerCase()}-${input.fromOn}-${input.toOn}-${input.currency}.${extension}` };
  }, { json: true, rejectQuery: true, maxBytes: 16384, feature: "F-FIN-37.download", respond: file => new Response(new Uint8Array(file.bytes), {
    headers: { "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.fileName}"`, "X-Content-Type-Options": "nosniff", "X-Request-ID": file.requestId }
  }) });
}
