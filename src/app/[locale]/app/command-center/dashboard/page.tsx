import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { dashboardAccess, dashboardProfiles } from "@/platform/command-center/dashboard";
import { CommandCenterExceptionsLink } from "@/platform/command-center/exceptions-link";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationReadiness } from "@/modules/reservations/application/operation-automation";
import { CommandCenterTodaySummary } from "@/modules/reservations/ui/command-center-today";
import { getCommandFinance } from "@/modules/finance/application/command-center-finance";
import { getCompanyLedger, CompanyLedgerAccessError, CompanyLedgerConfigurationError } from "@/modules/finance/application/company-ledger-service";
import { PerformanceReportAccessError, PerformanceReportUnavailableError } from "@/modules/finance/domain/performance-report";
import { CommandFinancePanel } from "@/modules/finance/ui/command-finance-panel";

export default async function RoleDashboardPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [session, query, t, shell] = await Promise.all([auth(), searchParams, getTranslations("CommandDashboard"), getTranslations("AppShell")]);
  if (!session?.user.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await reservationActorContextFromSession(session);
  if (!actor) notFound();
  const access = dashboardAccess(actor.authContext);
  if (!access.profiles.length) notFound();
  const requested = z.enum(dashboardProfiles).safeParse(query.view);
  if (query.view && (!requested.success || !access.profiles.includes(requested.data))) notFound();
  const role = requested.success ? requested.data : access.profiles[0];
  const base = `/${locale}/app`;
  const [financial, readiness] = await Promise.all([
    role !== "operations" && access.financial ? getCommandFinance(actor, {}).catch((error: unknown) => {
      if (error instanceof PerformanceReportAccessError || error instanceof PerformanceReportUnavailableError) return null;
      throw error;
    }) : null,
    role !== "finance" && access.operative ? operationReadiness(actor) : []
  ]);
  const ledger = !financial && role === "finance" && access.ledger ? await getCompanyLedger(actor).catch((error: unknown) => {
    if (error instanceof CompanyLedgerAccessError || error instanceof CompanyLedgerConfigurationError) return null;
    throw error;
  }) : null;
  const ready = readiness.filter(row => row.readiness === "READY").length;
  const delayed = readiness.reduce((sum, row) => sum + row.overdue, 0);
  const atRisk = readiness.reduce((sum, row) => sum + row.atRisk, 0);
  return <AdminShell className="resource-page" testId="command-role-dashboard">
    <ShellHeader title={t(role)} eyebrow={shell("eyebrow")} actions={<Link className="secondary-button" href={base}>{t("back")}</Link>} />
    {access.profiles.length > 1 ? <nav className="form-actions" aria-label={t("title")}>{access.profiles.map(profile =>
      <Link className="secondary-button" href={base + "/command-center/dashboard?view=" + profile} key={profile}
        aria-current={profile === role ? "page" : undefined}>{t(profile)}</Link>
    )}</nav> : null}
    {role !== "finance" ? <>
      {access.exceptions ? <CommandCenterExceptionsLink context={actor.authContext} locale={locale} /> : null}
      {access.operative || access.stays ? <CommandCenterTodaySummary actor={actor} locale={locale} /> : null}
      {access.operative ? <section className="detail-panel">
        <h2>{t("operating")}</h2>
        {readiness.length ? <dl className="detail-grid">
          <div><dt>{t("ready")}</dt><dd>{t("readyTotal", { ready, total: readiness.length })}</dd></div>
          <div><dt>{t("delayed")}</dt><dd>{t("total", { count: delayed })}</dd></div>
          <div><dt>{t("risk")}</dt><dd>{t("total", { count: atRisk })}</dd></div>
        </dl> : <EmptyState>{t("noReadiness")}</EmptyState>}
        <Link href={base + "/command-center/operations"} className="secondary-button">{t("openOperations")}</Link>
      </section> : null}
    </> : access.exceptions ? <CommandCenterExceptionsLink context={actor.authContext} locale={locale} /> : null}
    {financial ? <><CommandFinancePanel report={financial} locale={locale} />
      <Link href={base + "/command-center/finance"} className="secondary-button">{t("openFinance")}</Link></> : null}
    {ledger ? <section className="detail-panel">
      <h2>{t("ledger")}</h2>
      <p className="money">{formatCurrencyAmount(locale, ledger.closingBalance, ledger.currency)}</p>
      <Link href={base + "/finance/company-ledger"} className="secondary-button">{t("openLedger")}</Link>
    </section> : null}
    {role === "finance" && !financial && !ledger ? <EmptyState>{t("noFinance")}</EmptyState> : null}
  </AdminShell>;
}
