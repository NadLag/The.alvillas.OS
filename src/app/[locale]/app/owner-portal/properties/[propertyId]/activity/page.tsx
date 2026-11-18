import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatCurrency, formatDate } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { activitySelection, getOwnerFinancialActivity } from "@/modules/owner-portal/application/owner-financial-activity";
import { OwnerPortalAuthorizationError, OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";

export default async function OwnerActivityPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>;
  searchParams: Promise<{ from?: string; to?: string; currency?: string; bucket?: string; posting?: string; page?: string }>;
}) {
  const [{ locale: candidate, propertyId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const locale = safeLocale(candidate);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const [actor, t, owner] = await Promise.all([ownerPortalActorContextFromSession(session),
    getTranslations("OwnerPortal.activity"), getTranslations("OwnerPortal")]);
  const filters = activitySelection.safeParse({ ...query, bucket: query.bucket || undefined });
  if (!actor || !filters.success) notFound();
  const value = await getOwnerFinancialActivity(actor, propertyId, filters.data).catch((error: unknown) => {
    if (error instanceof OwnerPortalNotFoundError || error instanceof OwnerPortalAuthorizationError) notFound();
    throw error;
  });
  const property = `/${locale}/app/owner-portal/properties/${propertyId}`;
  const path = property + "/activity";
  const period = { from: value.from, to: value.to, currency: value.currency, ...(filters.data.bucket ? { bucket: filters.data.bucket } : {}) };
  const periodSearch = new URLSearchParams(period).toString();
  const date = (at: Date) => formatDate(locale, at, { timeZone: value.timezone });
  return <OwnerShell className="resource-page" testId="owner-financial-activity">
    <ShellHeader title={t("title")} eyebrow={value.propertyName}
      actions={<Link className="secondary-button" href={property + "?" + periodSearch}>{t("statement")}</Link>} />
    <form className="statement-filters" method="get">
      <label className="field"><span>{owner("periodFrom")}</span><input name="from" type="date" defaultValue={value.from} required /></label>
      <label className="field"><span>{owner("periodTo")}</span><input name="to" type="date" defaultValue={value.to} required /></label>
      <label className="field"><span>{owner("currency")}</span><select name="currency" defaultValue={value.currency}>
        {value.currencies.map(({ code }) => <option key={code} value={code}>{code}</option>)}
      </select></label>
      <label className="field"><span>{t("category")}</span><select name="bucket" defaultValue={filters.data.bucket ?? ""}>
        <option value="">{t("all")}</option>
        {value.totals.map(({ bucket }) => <option key={bucket} value={bucket}>{owner("buckets." + bucket)}</option>)}
      </select></label>
      <button className="primary-button" type="submit">{owner("applyPeriod")}</button>
    </form>
    <dl className="detail-grid">
      {value.totals.map(({ bucket, amount }) => <div key={bucket}>
        <dt>{owner("buckets." + bucket)}</dt><dd className="money">{formatCurrency(locale, amount)}</dd>
      </div>)}
    </dl>
    {value.detail ? <section className="panel resource-form" aria-label={t("details")}>
      <h2>{t("details")}</h2>
      <dl className="detail-grid">
        <div><dt>{owner("columns.reference")}</dt><dd dir="ltr">{value.detail.reference}</dd></div>
        <div><dt>{owner("columns.date")}</dt><dd>{date(value.detail.occurredAt)}</dd></div>
        <div><dt>{owner("columns.bucket")}</dt><dd>{owner("buckets." + value.detail.category)}</dd></div>
        <div><dt>{owner("columns.amount")}</dt><dd className="money">{formatCurrency(locale, value.detail.amount)}</dd></div>
      </dl>
      {value.detail.reversal ? <p>{t("reversal")}</p> : null}
      {value.detail.reservationId ? <Link className="secondary-button" href={property + "/reservations?reservation=" + value.detail.reservationId}>
        {t("reservation")}
      </Link> : null}
    </section> : null}
    {value.rows.length ? <ul className="resource-list">{value.rows.map(row => <li key={row.id}>
      <Link className="resource-row" prefetch={false} href={path + "?" + new URLSearchParams({ ...period, page: String(value.page), posting: row.id }).toString()}>
        <span><strong>{owner("buckets." + row.category)}</strong><small>{date(row.occurredAt)} {" / "} {row.reference}</small></span>
        <span className="money">{formatCurrency(locale, row.amount)}</span>
      </Link>
    </li>)}</ul> : <EmptyState tone="motif">{t("empty")}</EmptyState>}
    <div className="form-actions">
      {value.page > 1 ? <Link className="secondary-button" href={path + "?" + periodSearch + "&page=" + (value.page - 1)}>{t("previous")}</Link> : null}
      {value.more ? <Link className="secondary-button" href={path + "?" + periodSearch + "&page=" + (value.page + 1)}>{t("next")}</Link> : null}
    </div>
  </OwnerShell>;
}
