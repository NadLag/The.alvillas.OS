import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { exportCompanyPerformanceReport } from "@/modules/finance/application/company-performance-report";
import { accountantExportFormats, AccountantExportCapacityError, AccountantExportConfigurationError } from "@/modules/finance/domain/accountant-export";
import { companyReportMetrics, PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { performanceReportDownload, performanceReportFile } from "@/modules/finance/application/performance-report-file";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ locale: string; format: string }> }) {
  const [input, session] = await Promise.all([params, auth()]);
  const actor = await financeActorContextFromSession(session);
  const format = z.enum(accountantExportFormats).safeParse(input.format);
  if (!actor || !format.success) return new Response(null, { status: 404 });
  const locale = safeLocale(input.locale), query = new URL(request.url).searchParams;
  const filter = { fromOn: query.get("fromOn") ?? undefined, toOn: query.get("toOn") ?? undefined, currency: query.get("currency") ?? undefined };
  try {
    const bytes = await exportCompanyPerformanceReport(actor, filter, {
      format: format.data,
      render: (report, policy) => {
        const metrics = companyReportMetrics(report);
        const portfolio = report.properties.flatMap(row => {
          const subject = { id: row.propertyId, name: row.propertyName };
          return [{ key: "companyRevenue", amount: row.revenue, subject }, { key: "operatingCosts", amount: row.expense, subject },
            { key: "companyProfit", amount: row.profit, subject },
            { key: "occupancy", amount: null, count: row.occupancy === null ? null : row.occupancy + "%", subject }];
        });
        return performanceReportFile({ ...report, organizationId: actor.organizationId, propertyId: null, kind: "COMPANY_PERFORMANCE",
          metrics: [...metrics.financial, ...metrics.cash, ...portfolio] }, format.data, locale, policy, "companyTitle");
      }
    });
    return performanceReportDownload(bytes, format.data, "alvillas-company-performance");
  } catch (error) {
    if (error instanceof PerformanceReportAccessError) return new Response(null, { status: 404 });
    if (error instanceof PerformanceReportUnavailableError || error instanceof AccountantExportCapacityError ||
      error instanceof AccountantExportConfigurationError || error instanceof z.ZodError) {
      return new Response(null, { status: 422, headers: { "Cache-Control": "private, no-store" } });
    }
    throw error;
  }
}
