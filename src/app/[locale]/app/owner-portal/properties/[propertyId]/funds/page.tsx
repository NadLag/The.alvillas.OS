import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatCurrency, formatDate } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { getOwnerMoneyMovements } from "@/modules/owner-portal/application/owner-money-movements";
import { OwnerPortalAuthorizationError, OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";
import { statementPeriodSelectionSchema } from "@/modules/owner-portal/domain/owner-statement";

export default async function OwnerFundsPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>;
  searchParams: Promise<{ from?: string; to?: string; currency?: string; page?: string }>;
}) {
  const [{ locale: candidate, propertyId }, { page: pageParam, ...query }, session] = await Promise.all([params, searchParams, auth()]);
  const locale = safeLocale(candidate);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const [actor, t, owner] = await Promise.all([ownerPortalActorContextFromSession(session),
    getTranslations("OwnerPortal.funds"), getTranslations("OwnerPortal")]);
  const filters = statementPeriodSelectionSchema.safeParse(query), page = z.coerce.number().int().positive().safeParse(pageParam ?? 1);
  if (!actor || !filters.success || !page.success) notFound();
  const value = await getOwnerMoneyMovements(actor, propertyId, filters.data, page.data).catch((error: unknown) => {
    if (error instanceof OwnerPortalAuthorizationError || error instanceof OwnerPortalNotFoundError) notFound();
    throw error;
  });
  const property = `/${locale}/app/owner-portal/properties/${propertyId}`;
  const period = new URLSearchParams({ from: value.from, to: value.to, currency: value.currency }).toString();
  return <OwnerShell className="resource-page" testId="owner-funds">
    <ShellHeader title={t("title")} eyebrow={value.propertyName} actions={<Link className="secondary-button" href={property + "?" + period}>
      {owner("activity.statement")}
    </Link>} />
    <div className="form-actions"><Link className="secondary-button" href={property + "/payouts?" + period}>{owner("payouts.title")}</Link></div>
    <form className="statement-filters" method="get">
      <label className="field"><span>{owner("periodFrom")}</span><input type="date" name="from" defaultValue={value.from} required/></label>
      <label className="field"><span>{owner("periodTo")}</span><input type="date" name="to" defaultValue={value.to} required/></label>
      <label className="field"><span>{owner("currency")}</span><select name="currency" defaultValue={value.currency}>
        {value.currencies.map(({ code }) => <option key={code}>{code}</option>)}
      </select></label>
      <button className="primary-button" type="submit">{owner("applyPeriod")}</button>
    </form>
    <dl className="detail-grid">
      <div><dt>{owner("remainingPayable")}</dt><dd className="money">{formatCurrency(locale, value.payable)}</dd></div>
      <div><dt>{t("transferred")}</dt><dd className="money">{formatCurrency(locale, value.payments)}</dd></div>
      <div><dt>{t("direct")}</dt><dd>{t("directUnavailable")}</dd></div>
      <div><dt>{t("custody")}</dt><dd>{t("custodyUnavailable")}</dd></div>
    </dl>
    <section className="panel">
      <h2>{t("collected")}</h2>
      <p>{t("attribution")}</p>
      {value.collected.length ? <dl className="detail-grid">{value.collected.map(([rail, amount]) => <div key={rail}>
        <dt>{t("rails." + rail)}</dt><dd className="money">{formatCurrency(locale, amount)}</dd>
      </div>)}</dl> : <p>{t("empty")}</p>}
    </section>
    <section>
      <h2>{t("history")}</h2>
      {value.movements.length ? <ul className="resource-list">{value.movements.map(row => <li key={row.id} className="resource-row">
        <span><strong>{t("rails." + row.rail)}</strong><small>{formatDate(locale, row.occurredAt, { timeZone: value.timezone })}
          {row.reversal ? " / " + owner("activity.reversal") : ""}</small></span>
        <span className="money">{formatCurrency(locale, row.amount)}</span>
      </li>)}</ul> : <EmptyState tone="motif">{t("empty")}</EmptyState>}
      <div className="form-actions">
        {page.data > 1 ? <Link className="secondary-button" href={property + "/funds?" + period + "&page=" + (page.data - 1)}>{owner("activity.previous")}</Link> : null}
        {value.more ? <Link className="secondary-button" href={property + "/funds?" + period + "&page=" + (page.data + 1)}>{owner("activity.next")}</Link> : null}
      </div>
    </section>
  </OwnerShell>;
}
