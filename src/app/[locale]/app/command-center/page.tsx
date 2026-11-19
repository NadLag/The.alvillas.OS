import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatDate } from "@/i18n/format";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { commandTaskTitle, commandTodayGroups, getCommandCenterToday } from "@/modules/reservations/application/command-center-today";
import { CommandCenterTodayNavigation } from "@/modules/reservations/ui/command-center-today";

export default async function CommandCenterTodayPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ view?: string; page?: string }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const session = await auth();
  if (!session?.user.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await reservationActorContextFromSession(session);
  if (!actor) notFound();
  const [report, t, shell, reservations, operations, query] = await Promise.all([
    getCommandCenterToday(actor), getTranslations("CommandToday"), getTranslations("AppShell"), getTranslations("ReservationManagement"), getTranslations("Operations.manage"), searchParams
  ]);
  if (!report) notFound();
  const requested = z.enum(commandTodayGroups).safeParse(query.view);
  const view = requested.success && (requested.data === "incomplete" ? report.canViewJobs : report.canViewReservations)
    ? requested.data : report.canViewReservations ? "arrivals" : "incomplete";
  const paths = { reservations: `/${locale}/app/reservations/`, operations: `/${locale}/app/operations/` };
  const date = (value: string) => formatDate(locale, new Date(value + "T00:00:00Z"), { timeZone: "UTC" });
  const pageSize = 25;
  const last = Math.max(1, Math.ceil(report[view].length / pageSize));
  const parsed = z.coerce.number().int().positive().safeParse(query.page ?? "1");
  const current = Math.min(last, parsed.success ? parsed.data : 1);
  const range = [pageSize * (current - 1), pageSize * current] as const;
  const pageLink = (page: number) => `/${locale}/app/command-center?view=${view}&page=${page}`;
  const booking = (stay: (typeof report.arrivals)[number]) =>
    <Link href={paths.reservations + stay.id}>{stay.reference} · {reservations("states." + stay.status)}</Link>;
  return <AdminShell className="resource-page" testId="command-center-today">
    <ShellHeader title={t("title")} eyebrow={shell("eyebrow")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>} />
    <CommandCenterTodayNavigation report={report} locale={locale} active={view} />
    <section className="detail-panel">
      <h2>{t(view)}</h2>
      {!report[view].length ? <EmptyState>{t("empty")}</EmptyState> : null}
      {view === "arrivals" || view === "departures" ? <ul className="resource-list">{report[view].slice(...range).map(stay =>
        <li key={stay.id} className="resource-row">{booking(stay)}<span>{[stay.propertyName, date(stay.date)].filter(Boolean).join(" · ")}</span></li>
      )}</ul> : null}
      {view === "incomplete" ? <ul className="resource-list">{report.incomplete.slice(...range).map(job =>
        <li key={job.id} className="resource-row">
          <Link href={paths.operations + job.id}>{commandTaskTitle(job.title, locale, t("job"))}</Link>
          <span>{[job.propertyName, date(job.date), operations("states." + job.state)].filter(Boolean).join(" · ")}</span>
        </li>
      )}</ul> : null}
      {view === "turnovers" ? <ul className="resource-list">{report.turnovers.slice(...range).map(turn =>
        <li key={turn.propertyId} className="resource-row">
          <div><h3>{turn.propertyName ?? date(turn.date)}</h3>{turn.propertyName ? <p>{date(turn.date)}</p> : null}</div>
          <div><strong>{t("departures")}</strong><ul>{turn.departures.map(stay => <li key={stay.id}>{booking(stay)}</li>)}</ul></div>
          <div><strong>{t("arrivals")}</strong><ul>{turn.arrivals.map(stay => <li key={stay.id}>{booking(stay)}</li>)}</ul></div>
        </li>
      )}</ul> : null}
      {last > 1 ? <nav className="form-actions" aria-label={t(view)}>
        {current > 1 ? <Link className="secondary-button" href={pageLink(current - 1)}>{t("previous")}</Link> : null}
        {current < last ? <Link className="secondary-button" href={pageLink(current + 1)}>{t("next")}</Link> : null}
      </nav> : null}
    </section>
  </AdminShell>;
}
