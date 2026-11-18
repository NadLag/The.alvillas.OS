import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { exportPropertyPerformanceReport } from "@/modules/finance/application/property-performance-report";
import { accountantExportFormats, AccountantExportCapacityError, AccountantExportConfigurationError } from "@/modules/finance/domain/accountant-export";
import { PerformanceReportAccessError, PerformanceReportUnavailableError, propertyReportMetrics } from "@/modules/finance/domain/performance-report";
import { performanceReportDownload, performanceReportFile } from "@/modules/finance/application/performance-report-file";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ locale: string; propertyId: string; format: string }> }) {
  const [input, session] = await Promise.all([params, auth()]);
  const actor = await financeActorContextFromSession(session);
  const format = z.enum(accountantExportFormats).safeParse(input.format);
  if (!actor || !format.success || !z.uuid().safeParse(input.propertyId).success) return new Response(null, { status: 404 });
  const locale = safeLocale(input.locale), query = new URL(request.url).searchParams;
  const filter = { propertyId: input.propertyId, fromOn: query.get("fromOn") ?? undefined, toOn: query.get("toOn") ?? undefined,
    currency: query.get("currency") ?? undefined };
  try {
    const bytes = await exportPropertyPerformanceReport(actor, filter, {
      format: format.data,
      render: (report, policy) => {
        const metrics = propertyReportMetrics(report);
        return performanceReportFile({ ...report, organizationId: actor.organizationId, kind: "PROPERTY_PERFORMANCE",
          metrics: [...metrics.financial, ...metrics.occupancy] }, format.data, locale, policy, "propertyTitle");
      }
    });
    return performanceReportDownload(bytes, format.data, "property-performance-" + input.propertyId);
  } catch (error) {
    if (error instanceof PerformanceReportAccessError) return new Response(null, { status: 404 });
    if (error instanceof PerformanceReportUnavailableError || error instanceof AccountantExportCapacityError ||
      error instanceof AccountantExportConfigurationError || error instanceof z.ZodError) {
      return new Response(null, { status: 422, headers: { "Cache-Control": "private, no-store" } });
    }
    throw error;
  }
}
