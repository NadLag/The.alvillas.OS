import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatCurrency } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { getOwnerFinancialReport } from "@/modules/owner-portal/application/owner-financial-report";
import { OwnerPortalAuthorizationError, OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";

export default async function OwnerReportsPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>; searchParams: Promise<{ year?: string; currency?: string }>;
}) {
  const [{ locale: requested, propertyId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const locale = safeLocale(requested);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const [actor, t, labels] = await Promise.all([ownerPortalActorContextFromSession(session), getTranslations("OwnerPortal.reports"), getTranslations("OwnerPortal")]);
  const input = z.object({ year: z.string().regex(/^[1-9]\d{3}$/u), currency: z.string().regex(/^[A-Z]{3}$/u).optional() })
    .safeParse({ year: query.year ?? String(new Date().getUTCFullYear()), currency: query.currency });
  if (!actor || !input.success) notFound();
  const report = await getOwnerFinancialReport(actor, propertyId, input.data.year, input.data.currency).catch((error: unknown) => {
    if (error instanceof OwnerPortalNotFoundError || error instanceof OwnerPortalAuthorizationError) notFound();
    throw error;
  });
  const path = `/${locale}/app/owner-portal/properties/${propertyId}`;
  const month = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" });
  const yearPeriod = new URLSearchParams({ from: report.from, to: report.to, currency: report.currency }).toString();
  return <OwnerShell className="resource-page" testId="owner-reports">
    <ShellHeader title={t("title")} eyebrow={report.propertyName} actions={<Link className="secondary-button" href={path + "?" + yearPeriod}>{labels("activity.statement")}</Link>} />
    <form method="get" className="statement-filters">
      <label className="field"><span>{t("year")}</span><input name="year" type="number" min={1000} max={9999} defaultValue={input.data.year} required /></label>
      <label className="field"><span>{labels("currency")}</span><select name="currency" defaultValue={report.currency}>
        {report.currencies.map(({ code }) => <option key={code}>{code}</option>)}
      </select></label>
      <button type="submit" className="primary-button">{labels("applyPeriod")}</button>
    </form>
    <section className="panel resource-form" aria-label={t("annual")}>
      <h2>{t("annual")}</h2>
      <dl className="detail-grid">{report.totals.map(({ key, amount }) => <div key={key}>
        <dt>{t("columns." + key)}</dt><dd className="money">{formatCurrency(locale, amount)}</dd>
      </div>)}</dl>
    </section>
    <section className="panel resource-form">
      <h2>{t("settlements")}</h2>
      <dl className="detail-grid">
        <div><dt>{labels("remainingPayable")}</dt><dd className="money">{formatCurrency(locale, report.funds.payable)}</dd></div>
        <div><dt>{labels("funds.transferred")}</dt><dd className="money">{formatCurrency(locale, report.funds.transferred)}</dd></div>
        <div><dt>{labels("funds.direct")}</dt><dd>{labels("funds.directUnavailable")}</dd></div>
        <div><dt>{labels("funds.custody")}</dt><dd>{labels("funds.custodyUnavailable")}</dd></div>
        <div><dt>{labels("payouts.forecast")}</dt><dd>{
          report.payouts.forecast === null ? labels("payouts.unavailable") : formatCurrency(locale, report.payouts.forecast)
        }</dd></div>
        {report.funds.collected.map(([rail, amount]) => <div key={rail}>
          <dt>{labels("funds.rails." + rail)}</dt><dd className="money">{formatCurrency(locale, amount)}</dd>
        </div>)}
      </dl>
      <p>{labels("funds.attribution")}</p>
      {report.payouts.forecast !== null ? <p>{labels("payouts.estimate")}</p> : null}
      <div className="form-actions">
        <Link className="secondary-button" href={path + "/funds?" + yearPeriod}>{labels("funds.title")}</Link>
        <Link className="secondary-button" href={path + "/payouts?" + yearPeriod}>{labels("payouts.title")}</Link>
      </div>
    </section>
    <section className="resource-form" aria-label={t("monthly")}>
      <h2>{t("monthly")}</h2>
      {report.rows.length ? <ul className="resource-list">{report.rows.map(row => {
        const [year, calendarMonth] = row.month.split("-").map(Number);
        const lastDay = new Date(Date.UTC(year, calendarMonth, 0)).getUTCDate();
        const period = new URLSearchParams({ from: row.month + "-01", to: row.month + "-" + lastDay, currency: report.currency });
        return <li className="panel" key={row.month}>
        <h3>{month.format(new Date(row.month + "-01T00:00:00Z"))}</h3>
        <dl className="detail-grid">{report.columns.filter(key => !row.amount[key].amount.isZero()).map(key => <div key={key}>
          <dt>{t("columns." + key)}</dt><dd className="money">{formatCurrency(locale, row.amount[key])}</dd>
        </div>)}</dl>
        <Link className="secondary-button" href={path + "?" + period.toString()}>{t("monthlyStatement")}</Link>
      </li>;
      })}</ul> : <EmptyState tone="motif">{t("empty")}</EmptyState>}
    </section>
  </OwnerShell>;
}
