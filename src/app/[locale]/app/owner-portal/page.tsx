import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { routing, safeLocale } from "@/i18n/routing";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { listOwnerPortalProperties } from "@/modules/owner-portal/application/owner-portal-service";
import { updatePreferredLocaleAction } from "@/modules/identity/application/session-actions";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";

export default async function OwnerPortalPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session) {
    redirect(`/${appLocale}/login`);
  }

  const ctx = await ownerPortalActorContextFromSession(session);

  if (!ctx) {
    notFound();
  }

  const [t, preferences, properties] = await Promise.all([
    getTranslations("OwnerPortal"),
    getTranslations("AppShell"),
    listOwnerPortalProperties(ctx, {}, { includeCondition: true })
  ]);

  return (
    <OwnerShell className="resource-page" testId="owner-portal-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("backToWorkspace")}
        </Link>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      <section aria-label={t("preferences.title")} className="resource-form">
        <form action={updatePreferredLocaleAction.bind(null, appLocale)} className="preference-form">
          <input name="returnSurface" type="hidden" value="owner_portal" />
          <label className="field">
            <span>{preferences("languagePreference")}</span>
            <select defaultValue={safeLocale(session.user.preferredLocale)} name="preferredLocale">
              {routing.locales.map((language) => (
                <option key={language} value={language}>{preferences("languageNames." + language)}</option>
              ))}
            </select>
          </label>
          <button className="secondary-button" type="submit">{preferences("saveLanguagePreference")}</button>
        </form>
        <Link className="secondary-button" href={`/${appLocale}/app/notifications?from=owner-portal`}>
          {t("preferences.notifications")}
        </Link>
      </section>

      <section className="workspace-main">
        <div className="section-heading">
          <p className="panel-label">{t("propertiesLabel")}</p>
          <span data-testid="owner-property-count">
            {t("propertyCount", { count: properties.length })}
          </span>
        </div>
        {properties.length === 0 ? (
          <EmptyState testId="owner-properties-empty" tone="motif">{t("empty")}</EmptyState>
        ) : (
          <ul className="resource-list">
            {properties.map((property) => (
              <li className="resource-form" key={property.ownerId + ":" + property.propertyId}>
              <Link
                className="resource-row"
                data-testid="owner-property-row"
                href={`/${appLocale}/app/owner-portal/properties/${property.propertyId}${property.canViewFinances ? "" : "/reservations"}`}
              >
                <span>
                  <strong>{property.propertyName}</strong>
                  <small>{t("propertyMeta", { city: property.city, owner: property.ownerName })}</small>
                  {property.condition ? <small data-testid="owner-property-condition">{t("condition.states." + property.condition)}</small> : null}
                </span>
                <span>{t(property.canViewFinances ? "openStatement" : "reservationList.title")}</span>
              </Link>
              {property.canViewFinances ? (
              <Link className="secondary-button" href={`/${appLocale}/app/owner-portal/properties/${property.propertyId}/reservations`}>
                {t("reservationList.title")}
              </Link>
              ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </OwnerShell>
  );
}
