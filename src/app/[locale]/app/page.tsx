import { ReservationCommandExceptions } from "@/modules/reservations/ui/command-exceptions";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { LogoutForm } from "@/platform/offline/logout-form";
import { routing, safeLocale } from "@/i18n/routing";
import {
  logoutAction,
  updatePreferredLocaleAction
} from "@/modules/identity/application/session-actions";
import { resolveFeatureFlag } from "@/platform/config/feature-flags";
import { authorize } from "@/platform/authz/authorize";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function AppPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session?.user?.id || !session.user.organizationId) {
    redirect(`/${appLocale}/login`);
  }
  if (session.user.securitySetupRequired) redirect(`/${appLocale}/app/security`);

  const [t, dsnT, ownerPortalFlag] = await Promise.all([
    getTranslations("AppShell"),
    getTranslations("DesignSystem"),
    resolveFeatureFlag({
      organizationId: session.user.organizationId,
      key: "owner_portal",
      defaultEnabled: true
    })
  ]);

  const reservationContext = await reservationActorContextFromSession(session);
  return (
    <AdminShell className="app-shell" testId="app-shell">
      <ShellHeader
        actions={
          <nav className="app-actions" aria-label={t("actions")}>
          <Link className="secondary-button" href={`/${appLocale}/app/organization`}>
            {t("organization")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/owners`}>
            {t("owners")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/identity`}>
            {t("identity")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/team`}>
            {t("team")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/security`}>
            {t("security")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/audit`}>
            {t("audit")}
          </Link>
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "financial_transaction", organizationId: session.user.organizationId, dataClass: "financial" }) ?
            <Link className="secondary-button" data-testid="financial-accounts-link" href={`/${appLocale}/app/finance/accounts`}>{t("financialAccounts")}</Link> : null}
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "financial_transaction", organizationId: session.user.organizationId, dataClass: "financial" }) ?
            <Link className="secondary-button" data-testid="transaction-groups-link" href={`/${appLocale}/app/finance/groups`}>{t("transactionGroups")}</Link> : null}
          <Link className="secondary-button" href={`/${appLocale}/app/configuration`}>
            {t("configuration")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/automations`}>
            {t("automations")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/templates`}>
            {t("templates")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/properties`}>
            {t("properties")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/reservations`}>
            {t("reservations")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/operations`}>
            {t("operations")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/field`}>
            {t("field")}
          </Link>
          {ownerPortalFlag.enabled ? (
            <Link className="secondary-button" href={`/${appLocale}/app/owner-portal`}>
              {t("ownerPortal")}
            </Link>
          ) : null}
          <Link className="secondary-button" href={`/${appLocale}/app/design-system`}>
            {dsnT("nav")}
          </Link>
          <LocaleSwitch compact currentLocale={appLocale} label={t("language")} path="/app" />
          <LogoutForm action={logoutAction.bind(null, appLocale)} label={t("logout")} />
        </nav>
        }
        eyebrow={t("eyebrow")}
        title={t("title")}
      />
      <div className="workspace-grid">
        <section className="workspace-main">
          <p className="panel-label">{t("todayLabel")}</p>
          <h2>{t("welcome", { name: session.user?.name ?? session.user?.email ?? t("fallbackName") })}</h2>
          <p>{t("summary")}</p>
          {reservationContext ? <ReservationCommandExceptions ctx={reservationContext} locale={appLocale} /> : null}
        </section>
        <aside className="workspace-side" aria-label={t("sessionLabel")}>
          <form
            action={updatePreferredLocaleAction.bind(null, appLocale)}
            className="preference-form"
            data-testid="preferred-locale-form"
          >
            <label className="field">
              <span>{t("languagePreference")}</span>
              <select
                data-testid="preferred-locale-select"
                defaultValue={safeLocale(session.user.preferredLocale)}
                name="preferredLocale"
              >
                <option value="en">{t("languageNames.en")}</option>
                <option value="fr">{t("languageNames.fr")}</option>
                <option value="ar">{t("languageNames.ar")}</option>
              </select>
            </label>
            <button className="secondary-button" data-testid="preferred-locale-submit" type="submit">
              {t("saveLanguagePreference")}
            </button>
          </form>
          <dl>
            <div>
              <dt>{t("signedInAs")}</dt>
              <dd>{session.user?.email}</dd>
            </div>
            <div>
              <dt>{t("sessionScope")}</dt>
              <dd>{t("organizationScope")}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </AdminShell>
  );
}
