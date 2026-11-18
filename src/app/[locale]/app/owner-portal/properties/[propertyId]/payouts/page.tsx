import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatCurrency, formatDateTime } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { getOwnerPayoutHistory } from "@/modules/owner-portal/application/owner-payout-history";
import { OwnerPortalAuthorizationError, OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";
import { statementPeriodSelectionSchema } from "@/modules/owner-portal/domain/owner-statement";

export default async function OwnerPayoutPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>;
  searchParams: Promise<{ from?: string; to?: string; currency?: string; page?: string }>;
}) {
  const [{ locale: candidate, propertyId }, { page: pageParam, ...query }, session] = await Promise.all([params, searchParams, auth()]);
  const locale = safeLocale(candidate);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const [actor, t, owner] = await Promise.all([ownerPortalActorContextFromSession(session),
    getTranslations("OwnerPortal.payouts"), getTranslations("OwnerPortal")]);
  const filters = statementPeriodSelectionSchema.safeParse(query), page = z.coerce.number().int().positive().safeParse(pageParam ?? 1);
  if (!actor || !filters.success || !page.success) notFound();
  const value = await getOwnerPayoutHistory(actor, propertyId, filters.data, page.data).catch((error: unknown) => {
    if (error instanceof OwnerPortalAuthorizationError || error instanceof OwnerPortalNotFoundError) notFound();
    throw error;
  });
  const property = `/${locale}/app/owner-portal/properties/${propertyId}`;
  const period = new URLSearchParams({ from: value.from, to: value.to, currency: value.currency }).toString();
  const date = (at: Date) => formatDateTime(locale, at, { timeZone: value.timezone });
  return <OwnerShell className="resource-page" testId="owner-payouts">
    <ShellHeader title={t("title")} eyebrow={value.propertyName} actions={<Link className="secondary-button" href={property + "/funds?" + period}>{owner("funds.title")}</Link>} />
    {value.available ? <>
      <form className="statement-filters" method="get">
        <label className="field"><span>{owner("periodFrom")}</span><input name="from" type="date" defaultValue={value.from} required /></label>
        <label className="field"><span>{owner("periodTo")}</span><input name="to" type="date" defaultValue={value.to} required /></label>
        <label className="field"><span>{owner("currency")}</span><select name="currency" defaultValue={value.currency}>
          {value.currencies.map(({ code }) => <option key={code}>{code}</option>)}
        </select></label>
        <button className="primary-button" type="submit">{owner("applyPeriod")}</button>
      </form>
      <dl className="detail-grid">
        <div><dt>{t("forecast")}</dt><dd className="money">{formatCurrency(locale, value.plannedTotal)}</dd></div>
        <div><dt>{t("confirmed")}</dt><dd className="money">{formatCurrency(locale, value.transferredTotal)}</dd></div>
      </dl>
      <p>{t("estimate")}</p>
      {value.rows.length ? <ul className="resource-list">{value.rows.map(row => <li key={row.id} className="panel">
        <h2>{t("states." + row.state)}</h2>
        <dl className="detail-grid">
          {row.cadence ? <div><dt>{t("frequency")}</dt><dd>{t("cadences." + row.cadence)}</dd></div> : null}
          <div><dt>{t("method")}</dt><dd>{t("methods." + row.method)}</dd></div>
          {row.planned ? <div><dt>{t("forecast")}</dt><dd className="money">{formatCurrency(locale, row.planned)}</dd></div> : null}
          {row.transferred ? <div><dt>{t("confirmed")}</dt><dd className="money">{formatCurrency(locale, row.transferred)}</dd></div> : null}
          {row.eligibleAt ? <div><dt>{t("eligible")}</dt><dd>{date(row.eligibleAt)}</dd></div> : null}
          {row.expectedAt ? <div><dt>{t("expected")}</dt><dd>{date(row.expectedAt)}</dd></div> : null}
          {row.scheduledFor ? <div><dt>{t("scheduled")}</dt><dd>{date(row.scheduledFor)}</dd></div> : null}
          {row.confirmedAt ? <div><dt>{t("paidOn")}</dt><dd>{date(row.confirmedAt)}</dd></div> : null}
          {row.referenceSuffix ? <div><dt>{t("reference")}</dt><dd dir="ltr">{"\u2022\u2022\u2022\u2022"}{row.referenceSuffix}</dd></div> : null}
          {row.approvalSteps && row.state === "PENDING_APPROVAL" ? <div><dt>{t("approval")}</dt><dd>{t("steps", { count: row.approvalSteps })}</dd></div> : null}
        </dl>
      </li>)}</ul> : <EmptyState tone="motif">{t("empty")}</EmptyState>}
      <div className="form-actions">
        {page.data > 1 ? <Link className="secondary-button" href={property + "/payouts?" + period + "&page=" + (page.data - 1)}>{owner("activity.previous")}</Link> : null}
        {value.more ? <Link className="secondary-button" href={property + "/payouts?" + period + "&page=" + (page.data + 1)}>{owner("activity.next")}</Link> : null}
      </div>
    </> : <EmptyState tone="motif">{t("unavailable")}</EmptyState>}
  </OwnerShell>;
}
