import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import type { ReservationActorContext } from "../application/reservation-access";
import { commandTodayGroups, getCommandCenterToday } from "../application/command-center-today";

type Report = NonNullable<Awaited<ReturnType<typeof getCommandCenterToday>>>;
export async function CommandCenterTodaySummary({ actor, locale }: { actor: ReservationActorContext; locale: AppLocale }) {
  const report = await getCommandCenterToday(actor);
  if (!report) return null;
  const t = await getTranslations("CommandToday");
  return <section className="detail-panel" data-testid="command-center-today-summary">
    <h2>{t("title")}</h2>
    <CommandCenterTodayNavigation report={report} locale={locale} />
  </section>;
}

export async function CommandCenterTodayNavigation({ report, locale, active }: {
  report: Report; locale: AppLocale; active?: typeof commandTodayGroups[number];
}) {
  const t = await getTranslations("CommandToday");
  return <nav className="form-actions" aria-label={t("title")}>
    {commandTodayGroups.filter(key => key === "incomplete" ? report.canViewJobs : report.canViewReservations).map(key =>
      <Link className="secondary-button" key={key} aria-current={active === key ? "page" : undefined}
        href={`/${locale}/app/command-center?view=${key}`}>
        {t(key + "Count", { count: report[key].length })}
      </Link>
    )}
  </nav>;
}
