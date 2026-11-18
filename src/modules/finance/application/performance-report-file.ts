import type en from "../../../../messages/en.json";
import type { AppLocale } from "@/i18n/routing";
import { accountantExportRow, type AccountantExportColumn,
  type AccountantExportFormat, type ReportDocumentKind } from "../domain/accountant-export";
import type { PerformanceMetric } from "../domain/performance-report";
import { renderAccountantReportDocument, type AccountantExportLabels } from "./accountant-file-export";

type ExportSource = {
  organizationId: string;
  kind: ReportDocumentKind;
  propertyId: string | null;
  fromOn: string;
  toOn: string;
  timezone: string;
  currency: string;
  sourceFingerprint: string;
  generatedAt: string;
  metrics: readonly PerformanceMetric[];
};

export async function performanceReportFile(source: ExportSource, format: AccountantExportFormat, locale: AppLocale,
  policy: { id: string; version: number; capacity: number }, titleKey: "propertyTitle" | "companyTitle" | "teamTitle" | "inventoryTitle" | "kpiTitle") {
  const { default: catalog } = await import(`../../../../messages/${locale}.json`) as {
    default: typeof en;
  };
  const { AccountantExports: t, PerformanceReports: report } = catalog;
  const labels: AccountantExportLabels = { title: report[titleKey],
    headers: { ...t.columns, description: report.exportMetric, reference: report.exportCount },
    metadata: t.metadata, metadataRow: t.metadataRow, sourceRow: t.sourceRow, metadataSheet: t.metadataSheet, dataSheet: t.dataSheet };
  const columns: AccountantExportColumn[] = ["description", "amount", "reference"];
  const rows = source.metrics.map(({ key, amount, count, subject }) => accountantExportRow(subject ? subject.id + "." + key : key, columns, {
    description: (subject ? subject.name + " · " : "") + report.metric[key as keyof typeof report.metric], amount: amount?.toJSON().amount ?? null,
    reference: count ?? (amount === null ? report.unavailable : null)
  }));
  return renderAccountantReportDocument({
    organizationId: source.organizationId, kind: source.kind, currency: source.currency, fromOn: source.fromOn, toOn: source.toOn,
    scope: { propertyId: source.propertyId, accountId: null, ownerId: null }, timezone: source.timezone, policy: { id: policy.id, version: policy.version },
    sourceFingerprint: source.sourceFingerprint, generatedAt: source.generatedAt, columns, rows
  }, format, locale, labels, policy.capacity);
}

const downloadTypes = { CSV: ["csv", "text/csv; charset=utf-8"], EXCEL: ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  PDF: ["pdf", "application/pdf"] } as const;

export function performanceReportDownload(bytes: Uint8Array, format: AccountantExportFormat, name: string) {
  const [extension, contentType] = downloadTypes[format];
  return new Response(new Uint8Array(bytes), { headers: { "Cache-Control": "private, no-store",
    "Content-Type": contentType, "Content-Disposition": `attachment; filename="${name}.${extension}"`,
    "X-Content-Type-Options": "nosniff" } });
}
