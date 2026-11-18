import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatDate } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { listOwnerReservations, ownerReservationQuery } from "@/modules/owner-portal/application/owner-reservations";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";
import { auth } from "@/platform/auth/session";

export default async function OwnerReservationsPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>;
  searchParams: Promise<{ from?: string; until?: string; cursorDay?: string; cursorId?: string; reservation?: string }>;
}) {
  const [{ locale: candidate, propertyId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const locale = safeLocale(candidate);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const actor = await ownerPortalActorContextFromSession(session);
  const filters = ownerReservationQuery.safeParse({ propertyId, from: query.from || undefined, until: query.until || undefined,
    cursorDay: query.cursorDay, cursorId: query.cursorId, reservationId: query.reservation });
  if (!actor || !filters.success) notFound();
  const [t, data] = await Promise.all([
    getTranslations("OwnerPortal.reservationList"),
    listOwnerReservations(actor, filters.data).catch((error: unknown) => {
      if (error instanceof OwnerPortalNotFoundError || error instanceof RangeError) notFound();
      throw error;
    })
  ]);
  const portal = `/${locale}/app/owner-portal`;
  const property = portal + "/properties/" + data.propertyId;
  const date = (day: string) => formatDate(locale, new Date(day + "T00:00:00Z"), { timeZone: "UTC" });
  const next = data.cursor ? new URLSearchParams({ from: data.from, ...(data.until ? { until: data.until } : {}), ...data.cursor }) : null;
  return <OwnerShell className="resource-page" testId="owner-reservations">
    <ShellHeader eyebrow={data.propertyName} title={t("title")} actions={<Link className="secondary-button" href={portal}>{t("back")}</Link>} />
    <form className="resource-form">
      <div className="form-grid">
        <label className="field"><span>{t("from")}</span><input type="date" name="from" defaultValue={data.from} required /></label>
        <label className="field"><span>{t("until")}</span><input type="date" name="until" defaultValue={data.until} /></label>
      </div>
      <button type="submit" className="secondary-button">{t("filter")}</button>
    </form>
    {data.reservations.length ? <ul className="resource-list">
      {data.reservations.map(row => <li key={row.reference} className="resource-row">
        <span><strong dir="ltr">{row.reference}</strong><small>{t("stay", { arrival: date(row.checkIn), departure: date(row.checkOut) })}</small></span>
        <span>{t("status." + row.status)}</span>
      </li>)}
    </ul> : <EmptyState tone="motif">{t("empty")}</EmptyState>}
    {next ? <Link className="secondary-button" href={property + "/reservations?" + next.toString()}>{t("next")}</Link> : null}
  </OwnerShell>;
}
