import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listAirbnbSettlementVariances } from "@/modules/finance/application/airbnb-settlement-service";
import {
  listReservationsWithActiveRevenue,
  listRevenuePostingAccounts
} from "@/modules/finance/application/reservation-revenue-service";
import { AirbnbSettlementPanel } from "@/modules/finance/ui/airbnb-settlement-form";
import { ReservationRevenueForm } from "@/modules/finance/ui/reservation-revenue-form";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  listReservationPropertyOptions,
  listReservations
} from "@/modules/reservations/application/reservation-service";
import { ManualReservationForm } from "@/modules/reservations/ui/reservation-forms";
import { auth } from "@/platform/auth/session";
import { permissionKey } from "@/platform/authz/authorize";
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
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const canPostRevenue =
    ctx.authContext.permissions.has(permissionKey("financial_transaction", "create")) &&
    ctx.authContext.permissions.has(permissionKey("financial_transaction", "view"));
  const canReconcileSettlements =
    canPostRevenue && ctx.authContext.permissions.has(permissionKey("financial_transaction", "reconcile"));
  const [
    t,
    reservations,
    properties,
    revenueAccounts,
    postedRevenueReservationIds,
    settlementVariances
  ] = await Promise.all([
    getTranslations("Reservations"),
    listReservations(ctx),
    listReservationPropertyOptions(ctx),
    canPostRevenue ? listRevenuePostingAccounts(ctx) : Promise.resolve([]),
    canPostRevenue ? listReservationsWithActiveRevenue(ctx) : Promise.resolve([]),
    canReconcileSettlements ? listAirbnbSettlementVariances(ctx) : Promise.resolve([])
  ]);
  const postedRevenueReservations = new Set(postedRevenueReservationIds);
  const settlementVarianceViews = settlementVariances.map((variance) => ({
    id: variance.id,
    settlementId: variance.settlementId,
    reservationReference: variance.reservationReference,
    propertyName: variance.propertyName,
    sourceReservationId: variance.sourceReservationId,
    sourceTransactionId: variance.sourceTransactionId,
    expectedAmount: variance.expectedAmount.toJSON(),
    actualAmount: variance.actualAmount.toJSON(),
    varianceAmount: variance.varianceAmount.toJSON(),
    reason: variance.reason,
    action: variance.action
  }));

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
                <div className="resource-row reservation-row" data-testid="reservation-row" key={reservation.id}>
                  <div className="reservation-row-main">
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
                  {canPostRevenue ? (
                    <ReservationRevenueForm
                      locale={appLocale}
                      reservationId={reservation.id}
                      idempotencyKey={crypto.randomUUID()}
                      accounts={revenueAccounts}
                      posted={postedRevenueReservations.has(reservation.id)}
                      labels={{
                        amount: t("revenue.amount"),
                        currency: t("revenue.currency"),
                        account: t("revenue.account"),
                        noAccounts: t("revenue.noAccounts"),
                        recordRevenue: t("revenue.recordRevenue"),
                        recordingRevenue: t("revenue.recordingRevenue"),
                        revenuePosted: t("revenue.revenuePosted"),
                        saving: t("form.saving"),
                        validation: t("forms.validation"),
                        unauthorized: t("forms.unauthorized"),
                        forbidden: t("forms.forbidden"),
                        notFound: t("forms.notFound"),
                        config: t("forms.financeConfig"),
                        conflict: t("forms.revenueConflict"),
                        generic: t("forms.financeGeneric")
                      }}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {canReconcileSettlements ? (
            <AirbnbSettlementPanel
              locale={appLocale}
              idempotencyKey={crypto.randomUUID()}
              accounts={revenueAccounts}
              variances={settlementVarianceViews}
              labels={{
                title: t("settlement.title"),
                subtitle: t("settlement.subtitle"),
                csv: t("settlement.csv"),
                csvHint: t("settlement.csvHint"),
                account: t("settlement.account"),
                noAccounts: t("settlement.noAccounts"),
                import: t("settlement.import"),
                importing: t("settlement.importing"),
                variances: t("settlement.variances"),
                noVariances: t("settlement.noVariances"),
                expected: t("settlement.expected"),
                actual: t("settlement.actual"),
                variance: t("settlement.variance"),
                reason: t("settlement.reason"),
                action: t("settlement.action"),
                validation: t("forms.validation"),
                unauthorized: t("forms.unauthorized"),
                forbidden: t("forms.forbidden"),
                notFound: t("settlement.notFound"),
                config: t("settlement.config"),
                conflict: t("settlement.conflict"),
                generic: t("settlement.generic")
              }}
            />
          ) : null}
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
              externalId: t("form.externalId"),
              sources: {
                MANUAL: t("sources.MANUAL"),
                DIRECT: t("sources.DIRECT"),
                AGENCY: t("sources.AGENCY"),
                AIRBNB: t("sources.AIRBNB"),
                BOOKING: t("sources.BOOKING"),
                VRBO: t("sources.VRBO")
              },
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
