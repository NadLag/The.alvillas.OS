import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { listOwners } from "@/modules/core/application/core-service";
import { OwnerCreateForm } from "@/modules/core/ui/core-forms";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function OwnersPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = coreActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const [t, owners] = await Promise.all([getTranslations("Core"), listOwners(ctx)]);

  return (
    <section className="resource-page" data-testid="owners-page">
      <header className="resource-header">
        <div>
          <p className="eyebrow">{t("owners.eyebrow")}</p>
          <h1>{t("owners.title")}</h1>
          <p>{t("owners.subtitle")}</p>
        </div>
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("common.backToWorkspace")}
        </Link>
      </header>

      <div className="resource-layout">
        <section className="workspace-main">
          <div className="section-heading">
            <p className="panel-label">{t("owners.listLabel")}</p>
            <span data-testid="owner-count">{t("owners.count", { count: owners.length })}</span>
          </div>
          {owners.length === 0 ? (
            <p className="empty-state" data-testid="owners-empty">
              {t("owners.empty")}
            </p>
          ) : (
            <div className="resource-list">
              {owners.map((owner) => (
                <Link
                  className="resource-row"
                  data-testid="owner-row"
                  href={`/${appLocale}/app/owners/${owner.id}`}
                  key={owner.id}
                >
                  <span>
                    <strong>{owner.displayName}</strong>
                    <small>{owner.email ?? owner.phone ?? t("common.noContact")}</small>
                  </span>
                  <span>{t("owners.propertyCount", { count: owner.propertyCount })}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside className="workspace-side" aria-label={t("owners.createLabel")}>
          <p className="panel-label">{t("owners.createLabel")}</p>
          <OwnerCreateForm
            locale={appLocale}
            labels={{
              displayName: t("owners.form.displayName"),
              legalName: t("owners.form.legalName"),
              email: t("owners.form.email"),
              phone: t("owners.form.phone"),
              preferredLocale: t("owners.form.preferredLocale"),
              notes: t("owners.form.notes"),
              saveOwner: t("owners.form.saveOwner"),
              saving: t("common.saving"),
              validation: t("forms.validation"),
              unauthorized: t("forms.unauthorized"),
              forbidden: t("forms.forbidden"),
              notFound: t("forms.notFound"),
              generic: t("forms.generic")
            }}
          />
        </aside>
      </div>
    </section>
  );
}
