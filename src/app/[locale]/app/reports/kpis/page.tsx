import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { getKpiReport } from "@/modules/finance/application/kpi-report";
import { kpiSelectKeys } from "@/modules/finance/domain/kpi-report";
import { inventoryReportItems } from "@/modules/finance/domain/inventory-performance-report";
import { PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { PerformanceMetrics, PerformancePropertyFilter, PerformanceReportFilters } from "@/modules/finance/ui/performance-report-view";

export default async function KpiReportPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [actor, t, query] = await Promise.all([requireCompensationSession(locale), getTranslations("PerformanceReports"), searchParams]);
  const path = `/${locale}/app/reports/kpis`;
  const { page, ...selected } = query;
  const filters = Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== ""));
  const report = await getKpiReport(actor, filters).catch((error: unknown) => {
    if (error instanceof PerformanceReportAccessError) notFound();
    if (error instanceof PerformanceReportUnavailableError || error instanceof z.ZodError) return null;
    throw error;
  });
  const dimensions = Object.fromEntries(Object.entries(filters).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && !["fromOn", "toOn", "currency"].includes(entry[0])));
  const items = report ? inventoryReportItems(report.consumption, locale) : [];
  const pageSize = 25, last = Math.max(1, Math.ceil(items.length / pageSize));
  const requested = z.coerce.number().int().positive().safeParse(page ?? "1");
  const cursor = Math.min(last, requested.success ? requested.data : 1);
  const pageLink = (to: number) => path + "?" + new URLSearchParams({ ...dimensions, fromOn: report?.fromOn ?? "",
    toOn: report?.toOn ?? "", currency: report?.currency ?? "", page: String(to) }).toString();
  return <AdminShell className="resource-page" testId="kpi-performance-report">
    <ShellHeader title={t("kpiTitle")} eyebrow={report?.propertyName ?? t("eyebrow")}
      actions={<Link className="secondary-button" href={`}/${locale}/app/reports`}>{t("reportsBack")}</Link>} />
    {report ? <>
      <PerformanceReportFilters report={report} locale={locale} download={path + "/download"} filters={dimensions}
        fields={<>
          <PerformancePropertyFilter report={report} />
          {kpiSelectKeys.map(key => <label className="field" key={key}><span>{t("kpiFilter." + key)}</span>
            <select name={key} defaultValue={dimensions[key] ?? ""}>
              <option value="">{t("kpiAll")}</option>
              {report.choices[key].map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>)}
          <label className="field"><span>{t("kpiPeriod")}</span>
            <input name="period" defaultValue={dimensions.period ?? ""} maxLength={7} aria-describedby="kpi-period-help"
              pattern="[1-9][0-9]{3}(-(0[1-9]|1[0-2]|Q[1-4]))?" />
            <span className="field-hint" id="kpi-period-help">{t("kpiPeriodHelp")}</span>
          </label>
        </>} />
      <PerformanceMetrics title={t("kpiMetrics")} metrics={report.metrics} locale={locale} />
      <p className="field-hint">{t("kpiSourceLimits")}</p>
      {report.conflicts && report.conflicts !== "0" ? <p role="status">{t("calendarConflict")}</p> : null}
      {items.length ? <>
        <h2>{t("kpiInventory")}</h2>
        {items.slice((cursor - 1) * pageSize, cursor * pageSize).map(item =>
          <PerformanceMetrics key={item.id} title={[item.name, item.unit].filter(Boolean).join(" · ")} metrics={item.metrics} locale={locale} />)}
        {last > 1 ? <nav className="form-actions" aria-label={t("kpiInventory")}>
          {cursor > 1 ? <Link className="secondary-button" href={pageLink(cursor - 1)}>{t("previousItems")}</Link> : null}
          {cursor < last ? <Link className="secondary-button" href={pageLink(cursor + 1)}>{t("nextItems")}</Link> : null}
        </nav> : null}
      </> : null}
    </> : <EmptyState>{t("invalidRange")} <Link href={path}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
