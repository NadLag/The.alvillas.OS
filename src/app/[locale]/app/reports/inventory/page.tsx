import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { getInventoryPerformanceReport } from "@/modules/finance/application/inventory-performance-report";
import { inventoryReportItems } from "@/modules/finance/domain/inventory-performance-report";
import { PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { PerformanceMetrics, PerformancePropertyFilter, PerformanceReportFilters } from "@/modules/finance/ui/performance-report-view";

export default async function InventoryReportsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [actor, t, query] = await Promise.all([requireCompensationSession(locale), getTranslations("PerformanceReports"), searchParams]);
  const { page, propertyId, ...filters } = query;
  const path = `/${locale}/app/reports/inventory`;
  const report = await getInventoryPerformanceReport(actor, { ...filters, propertyId: propertyId === "" ? undefined : propertyId }).catch((error: unknown) => {
    if (error instanceof PerformanceReportAccessError) notFound();
    if (error instanceof PerformanceReportUnavailableError || error instanceof z.ZodError) return null;
    throw error;
  });
  const items = report ? inventoryReportItems(report.quantities, locale) : [];
  const pageSize = 25, last = Math.max(1, Math.ceil(items.length / pageSize));
  const requested = z.coerce.number().int().positive().safeParse(page ?? "1");
  const cursor = Math.min(last, requested.success ? requested.data : 1);
  const scope: Record<string, string> = report?.propertyId ? { propertyId: report.propertyId } : {};
  const pageLink = (to: number) => path + "?" + new URLSearchParams({ ...scope, fromOn: report?.fromOn ?? "",
    toOn: report?.toOn ?? "", currency: report?.currency ?? "", page: String(to) }).toString();
  const reset = report?.propertyId ? path + "?" + new URLSearchParams(scope).toString() : path;
  return <AdminShell className="resource-page" testId="inventory-performance-report">
    <ShellHeader title={t("inventoryTitle")} eyebrow={report?.propertyName ?? t("eyebrow")}
      actions={<Link className="secondary-button" href={`/${locale}/app/reports`}>{t("reportsBack")}</Link>} />
    {report ? <>
      <PerformanceReportFilters report={report} locale={locale} download={path + "/download"} filters={scope}
        fields={<PerformancePropertyFilter report={report} />} />
      <PerformanceMetrics title={t("inventoryCosts")} metrics={report.monetaryMetrics} locale={locale} />
      <p className="field-hint">{t("inventoryBasis")}</p>
      {items.length ? items.slice((cursor - 1) * pageSize, cursor * pageSize).map(item =>
        <PerformanceMetrics key={item.id} title={[item.name, item.unit].filter(Boolean).join(" · ")} metrics={item.metrics} locale={locale} />
      ) : <EmptyState>{t("emptyInventory")}</EmptyState>}
      {last > 1 ? <nav className="form-actions" aria-label={t("inventoryTitle")}>
        {cursor > 1 ? <Link className="secondary-button" href={pageLink(cursor - 1)}>{t("previousItems")}</Link> : null}
        {cursor < last ? <Link className="secondary-button" href={pageLink(cursor + 1)}>{t("nextItems")}</Link> : null}
      </nav> : null}
    </> : <EmptyState>{t("invalidRange")} <Link href={reset}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
