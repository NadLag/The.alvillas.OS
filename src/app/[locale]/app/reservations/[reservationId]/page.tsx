import { formatCurrencyAmount } from "@/i18n/format";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { authorize } from "@/platform/authz/authorize";
import { safeLocale } from "@/i18n/routing";
import { ManagerShell, ShellHeader } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { getReservationDetail } from "@/modules/reservations/application/reservation-management-service";
import { ReservationAuthorizationError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import { canTransition, reservationStates, terminalStates } from "@/modules/reservations/domain/reservation";
import { ManagementForm } from "@/modules/reservations/ui/management-form";

export const dynamic = "force-dynamic";
export default async function ReservationDetail({ params, searchParams }: { params: Promise<{ locale: string; reservationId: string }>; searchParams: Promise<{ guestSearch?: string }> }) {
  const values = await params, locale = safeLocale(values.locale); setRequestLocale(locale);
  const ctx = await reservationActorContextFromSession(await auth()); if (!ctx) redirect(`/${locale}/login`);
  if (!z.uuid().safeParse(values.reservationId).success) notFound();
  const t = await getTranslations("ReservationManagement");
  const search = await searchParams;
  let detail;
  try { detail = await getReservationDetail(ctx, values.reservationId, { guestSearch: search.guestSearch }); }
  catch (error) { if (error instanceof ReservationAuthorizationError || error instanceof ReservationNotFoundError) notFound(); throw error; }
  const r = detail.reservation, reservationId = r.id!, version = r.version!, status = r.status!;
  const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(value);
  const location = { city: r.property?.cityId ?? r.property?.city, region: r.property?.regionId ?? r.property?.region };
  const canEdit = authorize(ctx.authContext, "edit", { type: "reservation", organizationId: ctx.organizationId, ...location, propertyId: r.propertyId, reservationId, id: reservationId, status });
  const canPrice = authorize(ctx.authContext, "create", { type: "financial_transaction", organizationId: ctx.organizationId, ...location, propertyId: r.propertyId, reservationId });
  const canRefund = authorize(ctx.authContext, "void", { type: "financial_transaction", organizationId: ctx.organizationId, ...location, propertyId: r.propertyId, reservationId });
  const hidden = <><input type="hidden" name="reservationId" value={reservationId} /><input type="hidden" name="expectedVersion" value={version} /></>;
  const reason = <label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={3} maxLength={1000} required rows={2} /></label>;
  return <ManagerShell className="resource-page reservation-management-page" testId="reservation-detail-page">
    <ShellHeader eyebrow={t("eyebrow")} title={r.reference!} subtitle={`${r.property?.name} · ${r.guestName || t("unknownGuest")}`} actions={<Link className="secondary-button" href={`/${locale}/app/reservations/calendar?start=${r.checkIn!.toISOString().slice(0, 10)}&end=${r.checkOut!.toISOString().slice(0, 10)}&property=${r.propertyId}`}>{t("calendar")}</Link>} />
    <div className="resource-layout"><section className="workspace-main">
      <dl className="reservation-summary"><div><dt>{t("status")}</dt><dd data-testid="reservation-status">{t(`states.${status}`)}</dd></div><div><dt>{t("arrival")}</dt><dd>{date(r.checkIn!)}</dd></div><div><dt>{t("departure")}</dt><dd>{date(r.checkOut!)}</dd></div><div><dt>{t("revision")}</dt><dd data-testid="reservation-version">{version}</dd></div><div><dt>{t("guest")}</dt><dd>{r.guestName || t("unknownGuest")}</dd></div>{r.guestEmail ? <div><dt>{t("email")}</dt><dd>{r.guestEmail}</dd></div> : null}</dl>
      {r.cancellationSuspectedAt ? <p role="alert">{t("suspectedCancellation")}</p> : null}
      <h2>{t("history")}</h2><ol className="reservation-history">{detail.revisions.map(revision => <li key={revision.id} data-testid="reservation-history-row"><strong>{t("version", { version: revision.version })} · {t(`operations.${revision.operation}`)}</strong><p>{revision.reason}</p><time dateTime={revision.createdAt.toISOString()}>{date(revision.createdAt)}</time></li>)}</ol>
      {detail.canSeeMoney ? <><h2>{t("financialHistory")}</h2><p>{t("financialHistoryHint")}</p>{r.financialSnapshots?.map(snapshot => <article key={snapshot.id} className="reservation-snapshot" data-testid="reservation-financial-snapshot"><h3>{t("version", { version: snapshot.version })}</h3><p>{snapshot.amount && snapshot.currency ? formatCurrencyAmount(locale, snapshot.amount, snapshot.currency) : t("unknownPrice")}</p><p>{date(snapshot.createdAt)}</p><p>{t("rulesLocked")}</p>{(() => {
        const envelope = z.object({ owners: z.array(z.object({ ownerName: z.string(), shareBps: z.number(), commissionRateBps: z.number().optional(), configurationMissing: z.boolean() })).optional(), rules: z.array(z.object({ key: z.string(), version: z.number() })).optional() }).safeParse(snapshot.rules);
        return envelope.success ? <><ul>{envelope.data.owners?.map((owner, index) => <li key={index}>{owner.configurationMissing ? t("configurationMissing") : t("commissionRate", { owner: owner.ownerName, rate: new Intl.NumberFormat(locale).format((owner.commissionRateBps ?? 0) / 100), share: new Intl.NumberFormat(locale).format(owner.shareBps / 100) })}</li>)}</ul><ul>{envelope.data.rules?.map(rule => <li key={rule.key}>{t("ruleRevision", { rule: t(`financialRules.${rule.key}`), version: rule.version })}</li>)}</ul></> : null;
      })()}</article>)}</> : <p>{t("financialMasked")}</p>}
      {detail.canSeeGuests ? <><h2>{t("guestHistory")}</h2><p>{t("stays", { count: detail.stays.length })}</p><ul>{detail.stays.map(stay => <li key={stay.id}><Link href={`/${locale}/app/reservations/${stay.id}`}>{stay.reference} · {date(stay.checkIn)} · {t(`states.${stay.status}`)}</Link></li>)}</ul>
        {r.guestId && authorize(ctx.authContext, "edit", { type: "guest", organizationId: ctx.organizationId }) ? <details><summary>{t("mergeGuest")}</summary><form method="get"><label className="field"><span>{t("guestSearch")}</span><input name="guestSearch" defaultValue={search.guestSearch ?? r.guestName ?? ""} maxLength={160} /></label><button className="secondary-button">{t("searchGuests")}</button></form>{!detail.mergeCandidates.length ? <p>{t("noMergeCandidates")}</p> : <ManagementForm locale={locale} kind="merge" testId="merge-reservation-guests" idempotencyKey={crypto.randomUUID()} label={t("mergeGuest")}><input type="hidden" name="fromId" value={r.guestId} /><label className="field"><span>{t("targetGuest")}</span><select name="toId" required>{detail.mergeCandidates.map(guest => <option key={guest.id} value={guest.id}>{guest.displayName || t("unknownGuest")}{guest.email ? ` ? ${guest.email}` : ""}</option>)}</select></label>{reason}</ManagementForm>}</details> : null}</> : null}
    </section><aside className="workspace-side" aria-label={t("manageBooking")}>
      {canEdit ? <>
        {reservationStates.some(next => canTransition(status, next)) ? <details open><summary>{t("advanceStay")}</summary><ManagementForm locale={locale} kind="change" testId="transition-reservation" idempotencyKey={crypto.randomUUID()} label={t("updateStatus")}>{hidden}<input type="hidden" name="operation" value="TRANSITION" /><label className="field"><span>{t("nextStatus")}</span><select name="status">{reservationStates.filter(next => canTransition(status, next)).map(next => <option value={next} key={next}>{t(`states.${next}`)}</option>)}</select></label>{reason}</ManagementForm></details> : null}
        {!terminalStates.includes(status) && !["CHECKED_OUT", "FINANCIAL_RECONCILIATION"].includes(status) ? <details><summary>{t("modifyBooking")}</summary><ManagementForm locale={locale} kind="change" testId="modify-reservation" idempotencyKey={crypto.randomUUID()} label={t("saveChanges")}>{hidden}<input type="hidden" name="operation" value="MODIFY" /><label className="field"><span>{t("arrival")}</span><input name="checkIn" type="date" defaultValue={r.checkIn!.toISOString().slice(0, 10)} required /></label><label className="field"><span>{t("departure")}</span><input name="checkOut" type="date" defaultValue={r.checkOut!.toISOString().slice(0, 10)} required /></label>{detail.canSeeGuests ? <><label className="field"><span>{t("guest")}</span><input name="guestName" defaultValue={r.guestName || ""} maxLength={160} /></label><label className="field"><span>{t("email")}</span><input name="guestEmail" type="email" defaultValue={r.guestEmail ?? ""} /></label></> : null}{canPrice ? <><label className="field"><span>{t("amountOptional")}</span><input name="amount" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?" /></label><label className="field"><span>{t("currency")}</span><input name="currency" minLength={3} maxLength={3} /></label></> : null}{reason}</ManagementForm></details> : null}
        {["CHECKED_IN", "STAYING"].includes(status) ? <details><summary>{t("earlyCheckout")}</summary><ManagementForm locale={locale} kind="change" testId="early-checkout-reservation" idempotencyKey={crypto.randomUUID()} label={t("earlyCheckout")}>{hidden}<input type="hidden" name="operation" value="EARLY_CHECKOUT" /><label className="field"><span>{t("departure")}</span><input name="checkOut" type="date" required /></label>{reason}</ManagementForm></details> : null}
        {canRefund ? <details><summary>{t("refund")}</summary><p>{t("refundHint")}</p><ManagementForm locale={locale} kind="change" testId="refund-reservation" idempotencyKey={crypto.randomUUID()} label={t("refund")}>{hidden}<input type="hidden" name="operation" value="REFUND" />{reason}</ManagementForm></details> : null}
      </> : <p>{t("readOnly")}</p>}
    </aside></div>
  </ManagerShell>;
}
