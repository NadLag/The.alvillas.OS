import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { routing, safeLocale } from "@/i18n/routing";
import {
  logoutAction,
  updatePreferredLocaleAction
} from "@/modules/identity/application/session-actions";
import { resolveFeatureFlag } from "@/platform/config/feature-flags";

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

  const [t, dsnT, ownerPortalFlag] = await Promise.all([
    getTranslations("AppShell"),
    getTranslations("DesignSystem"),
    resolveFeatureFlag({
      organizationId: session.user.organizationId,
      key: "owner_portal",
      defaultEnabled: true
    })
  ]);

  return (
    <AdminShell className="app-shell" testId="app-shell">
      <ShellHeader
        actions={
          <nav className="app-actions" aria-label={t("actions")}>
          <Link className="secondary-button" href={`/${appLocale}/app/owners`}>
            {t("owners")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/identity`}>
            {t("identity")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/audit`}>
            {t("audit")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/configuration`}>
            {t("configuration")}
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
          <form action={logoutAction.bind(null, appLocale)}>
            <button className="secondary-button" data-testid="logout-button" type="submit">
              {t("logout")}
            </button>
          </form>
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
