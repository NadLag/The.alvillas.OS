import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReservationActorContext } from "../application/reservation-access";
import { listReservationCommandExceptions } from "../application/reservation-management-service";
import { authorizeCollection } from "@/platform/authz/authorize";

export async function ReservationCommandExceptions({ ctx, locale }: { ctx: ReservationActorContext; locale: string }) {
  if (!authorizeCollection(ctx.authContext, "view", "reservation")) return null;
  const [issues, t] = await Promise.all([listReservationCommandExceptions(ctx), getTranslations("ReservationManagement")]);
  if (!issues.length) return null;
  return <section className="reservation-command-exceptions" data-testid="reservation-command-exceptions"><h2>{t("exceptions")}</h2><ul>{issues.map(issue => <li key={issue.id}><Link href={issue.reservationId ? `/${locale}/app/reservations/${issue.reservationId}` : `/${locale}/app/reservations/calendar?property=${issue.propertyId}`}>{t(`exceptionKinds.${issue.kind}`)}</Link></li>)}</ul><Link className="secondary-button" href={`/${locale}/app/reservations/calendar`}>{t("calendar")}</Link></section>;
}
