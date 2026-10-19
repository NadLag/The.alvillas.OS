import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { auth } from "@/platform/auth/session";
import { authorizeCollection } from "@/platform/authz/authorize";
import { safeLocale } from "@/i18n/routing";
import { ManagerShell, ShellHeader, EmptyState } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { getReservationWorkspace } from "@/modules/reservations/application/reservation-management-service";
import { calendarQuerySchema } from "@/modules/reservations/domain/reservation";
import { ManagementForm, CsvField } from "@/modules/reservations/ui/management-form";

export const dynamic = "force-dynamic";
export default async function ReservationCalendar({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const ctx = await reservationActorContextFromSession(await auth()); if (!ctx) redirect(`/${locale}/login`);
  const t = await getTranslations("ReservationManagement"), sources = await getTranslations("Reservations.sources");
  const search = await searchParams, now = new Date(), month = now.toISOString().slice(0, 7);
  const defaultStart = `${month}-01`, defaultEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const parsed = calendarQuerySchema.safeParse({ start: search.start ?? defaultStart, end: search.end ?? defaultEnd, propertyId: search.property || undefined, page: search.page ?? 1, feedPage: search.feedPage ?? 1 });
  const query = parsed.success ? parsed.data : { start: defaultStart, end: defaultEnd, page: 1, feedPage: 1 };
  const workspace = await getReservationWorkspace(ctx, query);
  const days = Array.from({ length: (Date.parse(query.end) - Date.parse(query.start)) / 86400000 }, (_, i) => new Date(Date.parse(query.start) + i * 86400000));
  const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(value);
  const canConfigure = authorizeCollection(ctx.authContext, "configure", "reservation");
  const options = workspace.properties.map(property => <option key={property.id} value={property.id}>{property.name}</option>);
  const filters = new URLSearchParams({ start: query.start, end: query.end, ...(search.property ? { property: search.property } : {}) });
  return <ManagerShell className="resource-page reservation-management-page" testId="reservation-calendar-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("calendar")} subtitle={t("calendarSubtitle")} actions={<Link className="primary-button" href={`/${locale}/app/reservations`}>{t("createBooking")}</Link>} />
    {!parsed.success ? <p className="form-error" role="alert">{t("errors.validation")}</p> : null}
    <section className="workspace-main reservation-calendar-panel">
      <form className="reservation-filters" method="get">
        <label className="field"><span>{t("property")}</span><select name="property" defaultValue={search.property ?? ""}><option value="">{t("allProperties")}</option>{options}</select></label>
        <label className="field"><span>{t("from")}</span><input type="date" name="start" required defaultValue={query.start} /></label>
        <label className="field"><span>{t("to")}</span><input type="date" name="end" required defaultValue={query.end} /></label>
        <button type="submit" className="secondary-button">{t("apply")}</button>
      </form>
      <p>{t("resultCount", { count: workspace.total })} · {t("blockCount", { count: workspace.blockTotal })}</p>
      {!workspace.reservations.length && !workspace.blocks.length ? <EmptyState tone="motif">{t("empty")}</EmptyState> : <div className="reservation-calendar-scroll" tabIndex={0} role="region" aria-label={t("calendar")}>
        <table className="reservation-calendar"><caption>{date(new Date(query.start))} · {date(new Date(query.end))}</caption><thead><tr><th scope="col">{t("stay")}</th>{days.map(day => <th scope="col" key={day.toISOString()}><abbr title={date(day)}>{day.getUTCDate()}</abbr></th>)}</tr></thead><tbody>
          {workspace.reservations.map(row => <tr key={row.id} data-testid="calendar-reservation" data-status={row.status}><th scope="row"><Link href={`/${locale}/app/reservations/${row.id}`}><strong>{row.property?.name} · {row.reference}</strong><span>{row.guestName || t("unknownGuest")}</span><small>{t(`states.${row.status}`)}</small></Link></th>{days.map(day => <td key={day.toISOString()}>{row.checkIn && row.checkOut && day >= row.checkIn && day < row.checkOut && !["CANCELLED", "NO_SHOW"].includes(row.status ?? "") ? <span className={`reservation-day ${row.status === "IMPORTED" ? "reservation-day-imported" : ""}`} aria-label={t(`states.${row.status}`)} /> : null}</td>)}</tr>)}
          {workspace.blocks.map(block => <tr key={block.id} data-testid="calendar-block"><th scope="row"><span>{workspace.properties.find(p => p.id === block.propertyId)?.name}</span><strong>{t(`blockKinds.${block.kind}`)}</strong><small>{date(block.checkIn)} – {date(block.checkOut)}</small></th>{days.map(day => <td key={day.toISOString()}>{day >= block.checkIn && day < block.checkOut ? <span className="reservation-day reservation-day-block" aria-label={t(`blockKinds.${block.kind}`)} /> : null}</td>)}</tr>)}
        </tbody></table>
      </div>}
      <nav className="app-actions" aria-label={t("pagination")}>
        {query.page > 1 ? <Link className="secondary-button" href={`?${filters}&page=${query.page - 1}&feedPage=${query.feedPage}`}>{t("previous")}</Link> : null}
        <span>{t("page", { page: query.page })}</span>
        {query.page * 50 < Math.max(workspace.total, workspace.blockTotal) ? <Link className="secondary-button" href={`?${filters}&page=${query.page + 1}&feedPage=${query.feedPage}`}>{t("next")}</Link> : null}
      </nav>
      <h2>{t("turnovers")}</h2>
      {!workspace.turnovers.length ? <p>{t("noTurnovers")}</p> : <ul>{workspace.turnovers.map(turnover => <li key={`${turnover.departureId}:${turnover.arrivalId}`} data-testid="reservation-turnover">{workspace.properties.find(p => p.id === turnover.propertyId)?.name} · {date(turnover.date)} · <Link href={`/${locale}/app/reservations/${turnover.departureId}`}>{t("departure")}</Link> → <Link href={`/${locale}/app/reservations/${turnover.arrivalId}`}>{t("arrival")}</Link></li>)}</ul>}
    </section>
    <div className="resource-layout reservation-management-layout">
      <section className="workspace-main">
        <h2>{t("exceptions")}</h2>
        {!workspace.exceptions.length ? <p>{t("noExceptions")}</p> : <div className="resource-list">{workspace.exceptions.map(exception => <article className="reservation-exception" key={exception.id} data-testid="reservation-exception"><h3>{t(`exceptionKinds.${exception.kind}`)}</h3><p>{workspace.properties.find(p => p.id === exception.propertyId)?.name}</p>{exception.reservationId ? <Link href={`/${locale}/app/reservations/${exception.reservationId}`}>{t("reviewBooking")}</Link> : null}
          {exception.kind === "MISSING_FEED_ENTRY" ? <ManagementForm locale={locale} kind="missing" testId="missing-entry-review" idempotencyKey={crypto.randomUUID()} label={t("confirmReview")}><input type="hidden" name="exceptionId" value={exception.id} /><label className="field"><span>{t("decision")}</span><select name="decision"><option value="KEEP">{t("keepBooking")}</option><option value="CANCEL">{t("confirmCancellation")}</option></select></label><label className="field"><span>{t("reason")}</span><input name="reason" minLength={3} required /></label></ManagementForm> : !["DOUBLE_BOOKING", "BLOCK_OVERLAP", "FEED_SYNC_FAILED"].includes(exception.kind) ? <ManagementForm locale={locale} kind="resolve" testId="resolve-reservation-exception" idempotencyKey={crypto.randomUUID()} label={t("resolve")}><input type="hidden" name="exceptionId" value={exception.id} /><label className="field"><span>{t("resolution")}</span><input name="resolution" minLength={3} required /></label></ManagementForm> : <p>{t("correctSource")}</p>}
        </article>)}</div>}
        <h2>{t("syncHealth")}</h2><p>{t("icalLimitations")}</p>
        {!workspace.feeds.length ? <EmptyState>{t("noFeeds")}</EmptyState> : workspace.feeds.map(feed => <article className="reservation-feed" data-testid="reservation-feed" key={feed.id}><h3>{feed.name}</h3><p>{sources(feed.source)} · {workspace.properties.find(p => p.id === feed.propertyId)?.name}</p><p role="status">{!feed.enabled ? t("paused") : feed.consecutiveFailures ? t("syncFailed") : !feed.lastSuccessAt ? t("awaitingSync") : feed.stale || feed.nextSyncAt < now ? t("syncDelayed") : t("healthy")}</p><dl><div><dt>{t("lastSuccess")}</dt><dd>{feed.lastSuccessAt ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(feed.lastSuccessAt) : t("never")}</dd></div><div><dt>{t("failures")}</dt><dd>{feed.consecutiveFailures}</dd></div></dl>
          {canConfigure ? <div className="reservation-inline-forms"><ManagementForm locale={locale} kind="sync" testId="sync-reservation-feed" idempotencyKey={crypto.randomUUID()} label={t("syncNow")}><input type="hidden" name="feedId" value={feed.id} /></ManagementForm><ManagementForm locale={locale} kind="feed" testId="toggle-reservation-feed" idempotencyKey={crypto.randomUUID()} label={feed.enabled ? t("pause") : t("resume")}><input type="hidden" name="feedId" value={feed.id} /><input type="hidden" name="enabled" value={String(!feed.enabled)} /></ManagementForm></div> : null}
        </article>)}
        <nav className="app-actions" aria-label={t("syncHealth")}>
          {query.feedPage > 1 ? <Link className="secondary-button" href={`?${filters}&page=${query.page}&feedPage=${query.feedPage - 1}`}>{t("previous")}</Link> : null}
          <span>{t("page", { page: query.feedPage })}</span>
          {query.feedPage * 50 < workspace.feedTotal ? <Link className="secondary-button" href={`?${filters}&page=${query.page}&feedPage=${query.feedPage + 1}`}>{t("next")}</Link> : null}
        </nav>
        <h2>{t("importHistory")}</h2>{workspace.batches.length ? <ul>{workspace.batches.map(batch => <li key={batch.id}>{sources(batch.source)} · {date(batch.createdAt)} · {t("importResult", { imported: batch.imported, modified: batch.modified, duplicates: batch.duplicates })}</li>)}</ul> : <p>{t("noImports")}</p>}
      </section>
      <aside className="workspace-side" aria-label={t("tools")}>
        {canConfigure ? <details open><summary>{t("connectFeed")}</summary><ManagementForm locale={locale} kind="connect" testId="connect-reservation-feed" idempotencyKey={crypto.randomUUID()} label={t("connectFeed")}><label className="field"><span>{t("property")}</span><select name="propertyId" required defaultValue={search.property}>{options}</select></label><label className="field"><span>{t("source")}</span><select name="source">{["AIRBNB", "BOOKING", "VRBO"].map(value => <option value={value} key={value}>{sources(value)}</option>)}</select></label><label className="field"><span>{t("feedName")}</span><input name="name" maxLength={120} required /></label><label className="field"><span>{t("feedUrl")}</span><input name="url" type="url" autoComplete="off" required maxLength={2000} /></label></ManagementForm></details> : null}
        <details><summary>{t("importCsv")}</summary><ManagementForm locale={locale} kind="import" testId="import-reservations" idempotencyKey={crypto.randomUUID()} label={t("importCsv")}><label className="field"><span>{t("property")}</span><select name="propertyId" required defaultValue={search.property}>{options}</select></label><label className="field"><span>{t("source")}</span><select name="source">{["AIRBNB", "BOOKING", "VRBO", "DIRECT", "AGENCY", "MANUAL"].map(value => <option value={value} key={value}>{sources(value)}</option>)}</select></label><CsvField /></ManagementForm></details>
        <details><summary>{t("addBlock")}</summary><ManagementForm locale={locale} kind="block" testId="create-calendar-block" idempotencyKey={crypto.randomUUID()} label={t("addBlock")}><label className="field"><span>{t("property")}</span><select name="propertyId" required defaultValue={search.property}>{options}</select></label><label className="field"><span>{t("blockKind")}</span><select name="kind"><option value="OWNER">{t("blockKinds.OWNER")}</option><option value="MAINTENANCE">{t("blockKinds.MAINTENANCE")}</option></select></label><label className="field"><span>{t("from")}</span><input name="checkIn" type="date" required /></label><label className="field"><span>{t("to")}</span><input name="checkOut" type="date" required /></label><label className="field"><span>{t("reason")}</span><input name="reason" minLength={3} maxLength={500} required /></label></ManagementForm></details>
        {workspace.blocks.map(block => <details key={block.id}><summary>{t("releaseBlock")} · {date(block.checkIn)}</summary><ManagementForm locale={locale} kind="release" testId="release-calendar-block" idempotencyKey={crypto.randomUUID()} label={t("releaseBlock")}><input type="hidden" name="blockId" value={block.id} /><label className="field"><span>{t("reason")}</span><input name="reason" minLength={3} required /></label></ManagementForm></details>)}
      </aside>
    </div>
  </ManagerShell>;
}
