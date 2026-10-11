import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { listOwners, listProperties } from "@/modules/core/application/core-service";
import { PropertyCreateForm } from "@/modules/core/ui/core-forms";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function PropertiesPage({
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

  const [t, owners, properties] = await Promise.all([
    getTranslations("Core"),
    listOwners(ctx),
    listProperties(ctx)
  ]);

  return (
    <section className="resource-page" data-testid="properties-page">
      <header className="resource-header">
        <div>
          <p className="eyebrow">{t("properties.eyebrow")}</p>
          <h1>{t("properties.title")}</h1>
          <p>{t("properties.subtitle")}</p>
        </div>
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("common.backToWorkspace")}
        </Link>
      </header>

      <div className="resource-layout">
        <section className="workspace-main">
          <div className="section-heading">
            <p className="panel-label">{t("properties.listLabel")}</p>
            <span data-testid="property-count">{t("properties.count", { count: properties.length })}</span>
          </div>
          {properties.length === 0 ? (
            <p className="empty-state" data-testid="properties-empty">
              {t("properties.empty")}
            </p>
          ) : (
            <div className="resource-list">
              {properties.map((property) => (
                <Link
                  className="resource-row"
                  data-testid="property-row"
                  href={`/${appLocale}/app/properties/${property.id}`}
                  key={property.id}
                >
                  <span>
                    <strong>{property.name}</strong>
                    <small>{t("properties.rowMeta", { city: property.city, type: property.propertyType })}</small>
                  </span>
                  <span>{t(`properties.status.${property.status}`)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside className="workspace-side" aria-label={t("properties.createLabel")}>
          <p className="panel-label">{t("properties.createLabel")}</p>
          <PropertyCreateForm
            locale={appLocale}
            owners={owners.map((owner) => ({ id: owner.id, displayName: owner.displayName }))}
            labels={{
              owner: t("properties.form.owner"),
              noOwners: t("properties.form.noOwners"),
              name: t("properties.form.name"),
              addressLine1: t("properties.form.addressLine1"),
              addressLine2: t("properties.form.addressLine2"),
              city: t("properties.form.city"),
              region: t("properties.form.region"),
              countryCode: t("properties.form.countryCode"),
              propertyType: t("properties.form.propertyType"),
              bedrooms: t("properties.form.bedrooms"),
              bathrooms: t("properties.form.bathrooms"),
              livingSpaces: t("properties.form.livingSpaces"),
              maxGuests: t("properties.form.maxGuests"),
              parkingSpaces: t("properties.form.parkingSpaces"),
              timezone: t("properties.form.timezone"),
              hasPool: t("properties.form.hasPool"),
              hasGarden: t("properties.form.hasGarden"),
              amenities: t("properties.form.amenities"),
              photoUrls: t("properties.form.photoUrls"),
              saveProperty: t("properties.form.saveProperty"),
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
