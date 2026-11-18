import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { getTeamPerformanceReport } from "@/modules/finance/application/team-performance-report";
import { teamReportMetrics, PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { PerformanceMetrics, PerformanceReportFilters } from "@/modules/finance/ui/performance-report-view";

export default async function TeamReportsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ fromOn?: string | string[]; toOn?: string | string[]; currency?: string | string[]; page?: string }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [actor, t, query] = await Promise.all([requireCompensationSession(locale), getTranslations("PerformanceReports"), searchParams]);
  const { page, ...filters } = query;
  const path = `/${locale}/app/reports/team`;
  const requested = z.coerce.number().int().positive().safeParse(page ?? "1");
  const report = await getTeamPerformanceReport(actor, filters).catch((error: unknown) => {
    if (error instanceof PerformanceReportAccessError) notFound();
    if (error instanceof PerformanceReportUnavailableError || error instanceof z.ZodError) return null;
    throw error;
  });
  const pageSize = 25, last = Math.max(1, Math.ceil((report?.people.length ?? 0) / pageSize));
  const cursor = Math.min(last, requested.success ? requested.data : 1);
  const pageLink = (to: number) => path + "?" + new URLSearchParams({ fromOn: report?.fromOn ?? "",
    toOn: report?.toOn ?? "", currency: report?.currency ?? "", page: String(to) }).toString();
  return <AdminShell className="resource-page" testId="team-performance-report">
    <ShellHeader title={t("teamTitle")} eyebrow={t("eyebrow")}
      actions={<Link className="secondary-button" href={`/${locale}/app/reports`}>{t("reportsBack")}</Link>} />
    {report ? <>
      <PerformanceReportFilters report={report} locale={locale} download={path + "/download"} />
      {report.people.length ? report.people.slice((cursor - 1) * pageSize, cursor * pageSize).map(person =>
        <PerformanceMetrics key={person.id} title={person.name} metrics={teamReportMetrics(person, report.currency)} locale={locale} />
      ) : <EmptyState>{t("emptyTeam")}</EmptyState>}
      {last > 1 ? <nav className="form-actions" aria-label={t("teamTitle")}>
        {cursor > 1 ? <Link className="secondary-button" href={pageLink(cursor - 1)}>{t("previousPeople")}</Link> : null}
        {cursor < last ? <Link className="secondary-button" href={pageLink(cursor + 1)}>{t("nextPeople")}</Link> : null}
      </nav> : null}
    </> : <EmptyState>{t("invalidRange")} <Link href={path}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
