import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrency } from "@/i18n/format";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { PerformanceReportFilters } from "@/modules/finance/ui/performance-report-view";
import { getCommandFinance } from "@/modules/finance/application/command-center-finance";
import { PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";

export default async function CommandFinancePage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [actor, t, shell, filters] = await Promise.all([
    requireCompensationSession(locale), getTranslations("CommandFinance"), getTranslations("AppShell"), searchParams
  ]);
  const path = `/${locale}/app`;
  const report = await getCommandFinance(actor, filters).catch((error: unknown) => {
    if (error instanceof PerformanceReportAccessError) notFound();
    if (error instanceof PerformanceReportUnavailableError || error instanceof z.ZodError) return null;
    throw error;
  });
  return <AdminShell className="resource-page" testId="command-center-finance">
    <ShellHeader title={t("title")} eyebrow={shell("eyebrow")} actions={<Link href={path} className="secondary-button">{t("back")}</Link>} />
    {report ? <>
      <PerformanceReportFilters report={report} locale={locale} />
      <section className="detail-panel">
        <h2>{t("summary")}</h2>
        <dl className="detail-grid">{(["revenue", "expenses", "cash", "ownerPayable", "companyBalance"] as const).map(key =>
          <div key={key}><dt>{t(key)}</dt><dd className="money">{formatCurrency(locale, report[key])}</dd></div>)}</dl>
        <p className="field-hint">{t("basis")}</p>
        <nav className="form-actions" aria-label={t("summary")}>
          <Link href={path + "/finance/company-ledger"} className="secondary-button">{t("companyLedger")}</Link>
          <Link href={path + "/finance/owner-ledgers"} className="secondary-button">{t("ownerLedgers")}</Link>
        </nav>
      </section>
    </> : <EmptyState>{t("unavailable")} <Link href={path + "/command-center/finance"}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
