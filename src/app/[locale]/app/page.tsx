import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { routing, type AppLocale } from "@/i18n/routing";
import { logoutAction } from "@/modules/identity/application/session-actions";

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
  const appLocale = routing.locales.includes(locale as AppLocale)
    ? (locale as AppLocale)
    : routing.defaultLocale;
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("AppShell");
  const switchLocale = appLocale === "fr" ? "en" : "fr";

  return (
    <section className="app-shell" data-testid="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
        </div>
        <nav className="app-actions" aria-label={t("actions")}>
          <Link className="secondary-button" href={`/${appLocale}/app/owners`}>
            {t("owners")}
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
          <Link className="secondary-button" href={`/${switchLocale}/app`}>
            {t(`switch.${switchLocale}`)}
          </Link>
          <form action={logoutAction.bind(null, appLocale)}>
            <button className="secondary-button" data-testid="logout-button" type="submit">
              {t("logout")}
            </button>
          </form>
        </nav>
      </header>
      <div className="workspace-grid">
        <section className="workspace-main">
          <p className="panel-label">{t("todayLabel")}</p>
          <h2>{t("welcome", { name: session.user?.name ?? session.user?.email ?? "Admin" })}</h2>
          <p>{t("summary")}</p>
        </section>
        <aside className="workspace-side" aria-label={t("sessionLabel")}>
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
    </section>
  );
}
