import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { commandExceptionsPage, exceptionFilter, exceptionSections } from "@/platform/command-center/exceptions";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";

export default async function ExceptionsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [session, raw, t, shell, reservations] = await Promise.all([
    auth(), searchParams, getTranslations("CommandExceptions"), getTranslations("AppShell"), getTranslations("ReservationManagement")
  ]);
  if (!session?.user.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await reservationActorContextFromSession(session);
  if (!actor) notFound();
  const sections = exceptionSections(actor.authContext);
  if (!sections.length) notFound();
  const parsed = exceptionFilter.safeParse(raw);
  const filter = parsed.success ? parsed.data : {};
  const page = parsed.success ? await commandExceptionsPage(actor, filter) : { state: "changed" } as const;
  const path = `/${locale}/app/command-center/exceptions`;
  const href = (values: Record<string, string>) => path + "?" + new URLSearchParams(values).toString();
  const base = `/${locale}/app`;
  const amount = (value: string, currency: string | null) => currency
    ? formatCurrencyAmount(locale, value, currency) : new Intl.NumberFormat(locale).format(BigInt(value));
  return <AdminShell className="resource-page" testId="command-center-exceptions">
    <ShellHeader title={t("title")} eyebrow={shell("eyebrow")} actions={<Link href={base} className="secondary-button">{t("back")}</Link>} />
    <nav className="form-actions" aria-label={t("title")}>{sections.map(kind =>
      <Link key={kind} href={href({ kind })} className="secondary-button" aria-current={(filter.kind ?? sections[0]) === kind ? "page" : undefined}>{t(kind)}</Link>
    )}</nav>
    {(filter.kind ?? sections[0]) === "variances" ? <nav className="form-actions" aria-label={t("variances")}>
      {(["OTA", "BANK", "STAFF", "LAUNDRY"] as const).map(provider => <Link key={provider} className="quiet-button"
        aria-current={(filter.provider ?? "OTA") === provider ? "page" : undefined} href={href({ kind: "variances", provider })}>{t("provider." + provider)}</Link>)}
    </nav> : null}
    <section className="detail-panel">
      {page.state !== "ready" ? <EmptyState>{t(page.state)}{page.state === "changed" ? <Link href={path}>{t("restart")}</Link> : null}</EmptyState> : <>
        <h2>{t(page.kind)}</h2>
        {page.kind === "stock" ? <>
          <form className="statement-filters">
            <input type="hidden" name="kind" value="stock" />
            <label className="field"><span>{t("locationSearch")}</span><input name="locationQuery" defaultValue={filter.locationQuery} maxLength={100} /></label>
            <button className="secondary-button" type="submit">{t("find")}</button>
          </form>
          <nav className="form-actions" aria-label={t("locations")}>
            {page.locations.items.map(location => <Link key={location.id} className="quiet-button"
              aria-current={filter.location === location.id ? "page" : undefined}
              href={href({ kind: "stock", location: location.id, locationQuery: filter.locationQuery ?? "",
                ...(filter.locationAfter ? { locationAfter: filter.locationAfter } : {}) })}>{location.label}</Link>)}
            {page.locations.next ? <Link className="quiet-button" href={href({ kind: "stock", locationAfter: page.locations.next,
              locationQuery: filter.locationQuery ?? "" })}>{t("moreLocations")}</Link> : null}
          </nav>
          {page.stock ? <ul className="resource-list">{page.items.map(row => <li className="resource-row" key={row.item.id}>
            <strong>{localizedText(row.item.name, locale)}</strong>
            <span>{t("shortage", { current: amount(row.minimum!.current, null), minimum: amount(row.minimum!.minimum, null) })}</span>
          </li>)}</ul> : <p>{t("pickLocation")}</p>}
          <Link href={base + "/inventory/reorder"}>{t("reorder")}</Link>
        </> : null}
        {page.kind === "approvals" ? <ul className="resource-list">{page.items.map(row =>
          <li className="resource-row" key={row.id}><Link href={base + "/approvals/" + row.id + (row.stageId ? "?stage=" + row.stageId : "")}>{row.title}</Link>
            {row.propertyName ? <span>{row.propertyName}</span> : null}</li>)}</ul> : null}
        {page.kind === "maintenance" ? <ul className="resource-list">{page.items.map(row =>
          <li className="resource-row" key={row.id}><Link href={base + "/maintenance/issues/" + row.id}>{row.title}</Link></li>)}</ul> : null}
        {page.kind === "conflicts" || page.kind === "sync" ? <ul className="resource-list">{page.items.map(row =>
          <li className="resource-row" key={row.id}>
            <Link href={row.reservationId ? base + "/reservations/" + row.reservationId : base + "/reservations/calendar?property=" + row.propertyId}>
              {reservations("exceptionKinds." + row.kind)}
            </Link>
            {row.propertyName ? <span>{row.propertyName}</span> : null}
          </li>)}</ul> : null}
        {page.kind === "variances" ? <ul className="resource-list">{page.items.map(row =>
          <li className="resource-row" key={row.detail.source.id}>
            <Link href={base + "/finance/variances/" + page.provider + "/" + row.detail.source.id}>{row.reference}</Link>
            {row.detail.facts.variance !== null ? <span className={row.detail.facts.currency ? "money" : undefined}>
              {amount(row.detail.facts.variance, row.detail.facts.currency)}</span> : null}
          </li>)}</ul> : null}
        {!page.items.length && (page.kind !== "stock" || page.stock) ? <EmptyState>{t(page.next ? "emptyPage" : "empty")}</EmptyState> : null}
        {page.next ? <Link className="secondary-button" href={href({ kind: page.kind, after: page.next,
          ...(page.kind === "variances" ? { provider: page.provider } : {}),
          ...(page.kind === "stock" && filter.location ? { location: filter.location, locationQuery: filter.locationQuery ?? "",
            ...(filter.locationAfter ? { locationAfter: filter.locationAfter } : {}) } : {}) })}>{t("next")}</Link> : null}
      </>}
    </section>
  </AdminShell>;
}
