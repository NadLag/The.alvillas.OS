import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { exportInventoryPerformanceReport } from "@/modules/finance/application/inventory-performance-report";
import { accountantExportFormats, AccountantExportCapacityError, AccountantExportConfigurationError } from "@/modules/finance/domain/accountant-export";
import { PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { inventoryReportItems } from "@/modules/finance/domain/inventory-performance-report";
import { performanceReportDownload, performanceReportFile } from "@/modules/finance/application/performance-report-file";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ locale: string; format: string }> }) {
  const [input, session] = await Promise.all([params, auth()]);
  const actor = await financeActorContextFromSession(session);
  const format = z.enum(accountantExportFormats).safeParse(input.format);
  if (!actor || !format.success) return new Response(null, { status: 404 });
  const locale = safeLocale(input.locale), query = new URL(request.url).searchParams;
  const filter = { propertyId: query.get("propertyId") ?? undefined, fromOn: query.get("fromOn") ?? undefined, toOn: query.get("toOn") ?? undefined, currency: query.get("currency") ?? undefined };
  try {
    const bytes = await exportInventoryPerformanceReport(actor, filter, {
      format: format.data,
      render: (report, policy) => {
        const metrics = [...report.monetaryMetrics, ...inventoryReportItems(report.quantities, locale).flatMap(item => item.metrics)];
        return performanceReportFile({ ...report, organizationId: actor.organizationId, kind: "INVENTORY_PERFORMANCE",
          metrics }, format.data, locale, policy, "inventoryTitle");
      }
    });
    return performanceReportDownload(bytes, format.data, "alvillas-team-performance");
  } catch (error) {
    if (error instanceof PerformanceReportAccessError) return new Response(null, { status: 404 });
    if (error instanceof PerformanceReportUnavailableError || error instanceof AccountantExportCapacityError ||
      error instanceof AccountantExportConfigurationError || error instanceof z.ZodError) {
      return new Response(null, { status: 422, headers: { "Cache-Control": "private, no-store" } });
    }
    throw error;
  }
}
