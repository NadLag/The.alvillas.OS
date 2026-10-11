import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  listReservationPropertyOptions,
  listReservations
} from "@/modules/reservations/application/reservation-service";
import { ManualReservationForm } from "@/modules/reservations/ui/reservation-forms";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function ReservationsPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const [t, reservations, properties] = await Promise.all([
    getTranslations("Reservations"),
    listReservations(ctx),
    listReservationPropertyOptions(ctx)
  ]);

  return (
    <section className="resource-page" data-testid="reservations-page">
      <header className="resource-header">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("backToWorkspace")}
        </Link>
      </header>

      <div className="resource-layout">
        <section className="workspace-main">
          <div className="section-heading">
            <p className="panel-label">{t("listLabel")}</p>
            <span data-testid="reservation-count">{t("count", { count: reservations.length })}</span>
          </div>
          {reservations.length === 0 ? (
            <p className="empty-state" data-testid="reservations-empty">
              {t("empty")}
            </p>
          ) : (
            <div className="resource-list">
              {reservations.map((reservation) => (
                <div className="resource-row" data-testid="reservation-row" key={reservation.id}>
                  <span>
                    <strong>{reservation.reference}</strong>
                    <small>
                      {t("rowMeta", {
                        property: reservation.propertyName,
                        guest: reservation.guestName
                      })}
                    </small>
                  </span>
                  <span>
                    {t("stayDates", {
                      checkIn: reservation.checkIn,
                      checkOut: reservation.checkOut
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="workspace-side" aria-label={t("createLabel")}>
          <p className="panel-label">{t("createLabel")}</p>
          <ManualReservationForm
            locale={appLocale}
            properties={properties}
            idempotencyKey={crypto.randomUUID()}
            labels={{
              property: t("form.property"),
              noProperties: t("form.noProperties"),
              guestName: t("form.guestName"),
              guestEmail: t("form.guestEmail"),
              source: t("form.source"),
              checkIn: t("form.checkIn"),
              checkOut: t("form.checkOut"),
              adultCount: t("form.adultCount"),
              childCount: t("form.childCount"),
              notes: t("form.notes"),
              saveReservation: t("form.saveReservation"),
              saving: t("form.saving"),
              validation: t("forms.validation"),
              unauthorized: t("forms.unauthorized"),
              forbidden: t("forms.forbidden"),
              notFound: t("forms.notFound"),
              config: t("forms.config"),
              generic: t("forms.generic")
            }}
          />
        </aside>
      </div>
    </section>
  );
}
