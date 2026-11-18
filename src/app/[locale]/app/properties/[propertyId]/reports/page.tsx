import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { getPropertyPerformanceReport } from "@/modules/finance/application/property-performance-report";
import { PerformanceReportAccessError, PerformanceReportUnavailableError, propertyReportMetrics } from "@/modules/finance/domain/performance-report";
import { PerformanceMetrics, PerformanceReportFilters } from "@/modules/finance/ui/performance-report-view";

export default async function PropertyReportsPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>;
  searchParams: Promise<{ fromOn?: string | string[]; toOn?: string | string[]; currency?: string | string[] }>;
}) {
  const { locale: requested, propertyId } = await params;
  const locale = safeLocale(requested);
  setRequestLocale(locale);
  if (!z.uuid().safeParse(propertyId).success) notFound();
  const [actor, t, filter] = await Promise.all([requireCompensationSession(locale), getTranslations("PerformanceReports"), searchParams]);
  const path = `/${locale}/app/properties/${propertyId}`;
  const report = await getPropertyPerformanceReport(actor, { ...filter, propertyId }).catch((error: unknown) => {
    if (error instanceof PerformanceReportAccessError) notFound();
    if (error instanceof PerformanceReportUnavailableError || error instanceof z.ZodError) return null;
    throw error;
  });
  const metrics = report ? propertyReportMetrics(report) : null;
  return <AdminShell className="resource-page" testId="property-performance-report">
    <ShellHeader title={t("propertyTitle")} eyebrow={report?.propertyName ?? t("eyebrow")}
      actions={<Link className="secondary-button" href={path + "/finance"}>{t("propertyBack")}</Link>} />
    {report && metrics ? <>
      <PerformanceReportFilters report={report} locale={locale} download={path + "/reports/download"} />
      <PerformanceMetrics title={t("profitAndLoss")} metrics={metrics.financial} locale={locale} />
      <PerformanceMetrics title={t("stayPerformance")} metrics={metrics.occupancy} locale={locale} />
      <p className="field-hint">{t("postingBasis")}</p>
      {report.conflicts !== "0" ? <p role="status">{t("calendarConflict")}</p> : null}
    </> : <EmptyState>{t("invalidRange")} <Link href={path + "/reports"}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
