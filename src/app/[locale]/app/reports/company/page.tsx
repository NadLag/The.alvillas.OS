import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrency, formatPercentageAmount } from "@/i18n/format";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { getCompanyPerformanceReport } from "@/modules/finance/application/company-performance-report";
import { companyReportMetrics, PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { PerformanceMetrics, PerformanceReportFilters } from "@/modules/finance/ui/performance-report-view";

export default async function CompanyReportsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ fromOn?: string | string[]; toOn?: string | string[]; currency?: string | string[]; page?: string }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [actor, t, query] = await Promise.all([requireCompensationSession(locale), getTranslations("PerformanceReports"), searchParams]);
  const { page, ...filters } = query;
  const path = `/${locale}/app/reports/company`;
  const requested = z.coerce.number().int().positive().safeParse(page ?? "1");
  const report = await getCompanyPerformanceReport(actor, filters).catch((error: unknown) => {
    if (error instanceof PerformanceReportAccessError) notFound();
    if (error instanceof PerformanceReportUnavailableError || error instanceof z.ZodError) return null;
    throw error;
  });
  const metrics = report ? companyReportMetrics(report) : null;
  const pageSize = 50;
  const last = Math.max(1, Math.ceil((report?.properties.length ?? 0) / pageSize));
  const cursor = Math.min(last, requested.success ? requested.data : 1);
  const pageLink = (to: number) => path + "?" + new URLSearchParams({ fromOn: report?.fromOn ?? "",
    toOn: report?.toOn ?? "", currency: report?.currency ?? "", page: String(to) }).toString();
  return <AdminShell className="resource-page" testId="company-performance-report">
    <ShellHeader title={t("companyTitle")} eyebrow={t("eyebrow")}
      actions={<Link className="secondary-button" href={`/${locale}/app/reports`}>{t("reportsBack")}</Link>} />
    {report && metrics ? <>
      <PerformanceReportFilters report={report} locale={locale} download={path + "/download"} />
      <PerformanceMetrics title={t("profitAndLoss")} metrics={metrics.financial} locale={locale} />
      <PerformanceMetrics title={t("cashLocations")} metrics={metrics.cash} locale={locale} />
      <p>{t("cashBasis")}</p>
      <section className="detail-panel">
        <h2>{t("portfolio")}</h2>
        {report.properties.length ? <ul className="resource-list">
          {report.properties.slice((cursor - 1) * pageSize, cursor * pageSize).map(row => (
            <li className="resource-form" key={row.propertyId}>
              <Link href={`/${locale}/app/properties/${row.propertyId}/reports?${new URLSearchParams({ fromOn: report.fromOn, toOn: report.toOn, currency: report.currency })}`}>
                {row.propertyName}
              </Link>
              <dl className="detail-grid">
                <div><dt>{t("metric.companyRevenue")}</dt><dd className="money">{formatCurrency(locale, row.revenue)}</dd></div>
                <div><dt>{t("metric.operatingCosts")}</dt><dd className="money">{formatCurrency(locale, row.expense)}</dd></div>
                <div><dt>{t("metric.companyProfit")}</dt><dd className="money">{formatCurrency(locale, row.profit)}</dd></div>
                <div><dt>{t("metric.occupancy")}</dt><dd>{row.occupancy === null ? t("unavailable") : formatPercentageAmount(locale, row.occupancy, 2)}</dd></div>
              </dl>
            </li>
          ))}
        </ul> : <EmptyState>{t("emptyPortfolio")}</EmptyState>}
        <nav className="form-actions" aria-label={t("portfolio")}>
          {cursor > 1 ? <Link className="secondary-button" href={pageLink(cursor - 1)}>{t("previous")}</Link> : null}
          {cursor < last ? <Link className="secondary-button" href={pageLink(cursor + 1)}>{t("next")}</Link> : null}
        </nav>
      </section>
    </> : <EmptyState>{t("invalidRange")} <Link href={path}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
