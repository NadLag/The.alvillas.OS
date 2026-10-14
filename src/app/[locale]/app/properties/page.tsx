import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { listOwners, listProperties } from "@/modules/core/application/core-service";
import { PropertyCreateForm } from "@/modules/core/ui/core-forms";
import { PropertyRegisterTable } from "@/modules/core/ui/core-tables";
import { listGeography } from "@/modules/organization/application/geography-service";
import { organizationActorContextFromSession } from "@/modules/organization/application/organization-access";
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
  const organizationCtx = await organizationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const [t, owners, properties, geography] = await Promise.all([
    getTranslations("Core"),
    listOwners(ctx),
    listProperties(ctx),
    organizationCtx ? listGeography(organizationCtx).catch(() => ({ cities: [], regions: [] })) : { cities: [], regions: [] }
  ]);
  const dsnT = await getTranslations("DesignSystem");
  const propertyRows = properties.map((property) => ({
    id: property.id,
    href: `/${appLocale}/app/properties/${property.id}`,
    meta: t("properties.rowMeta", { city: property.city, type: property.propertyType }),
    name: property.name,
    status: t(`properties.status.${property.status}`)
  }));

  return (
    <AdminShell className="resource-page" testId="properties-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("common.backToWorkspace")}
        </Link>
        }
        eyebrow={t("properties.eyebrow")}
        subtitle={t("properties.subtitle")}
        title={t("properties.title")}
      />

      <div className="resource-layout">
        <section className="workspace-main">
          <div className="section-heading">
            <p className="panel-label">{t("properties.listLabel")}</p>
            <span data-testid="property-count">{t("properties.count", { count: properties.length })}</span>
          </div>
          {properties.length === 0 ? (
            <EmptyState testId="properties-empty" tone="motif">{t("properties.empty")}</EmptyState>
          ) : null}
          <PropertyRegisterTable
            labels={{
              empty: dsnT("dataTable.empty"),
              exportCsv: dsnT("dataTable.exportCsv"),
              location: dsnT("dataTable.location"),
              property: dsnT("dataTable.property"),
              rows: dsnT("dataTable.rows"),
              saveView: dsnT("dataTable.saveView"),
              search: dsnT("dataTable.search"),
              status: dsnT("dataTable.status"),
              viewName: dsnT("dataTable.viewName")
            }}
            rows={propertyRows}
          />
        </section>

        <aside className="workspace-side" aria-label={t("properties.createLabel")}>
          <p className="panel-label">{t("properties.createLabel")}</p>
          <PropertyCreateForm
            cities={geography.cities.map((city) => ({ id: city.id, name: city.name, regionName: city.regionName }))}
            locale={appLocale}
            owners={owners.map((owner) => ({ id: owner.id, displayName: owner.displayName }))}
            labels={{
              owner: t("properties.form.owner"),
              noOwners: t("properties.form.noOwners"),
              noCities: t("properties.form.noCities"),
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
              onboardingSection: t("properties.form.onboardingSection"),
              headline: t("properties.form.headline"),
              description: t("properties.form.description"),
              publicDirections: t("properties.form.publicDirections"),
              internalAccessNotes: t("properties.form.internalAccessNotes"),
              houseRules: t("properties.form.houseRules"),
              onboardingNotes: t("properties.form.onboardingNotes"),
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
    </AdminShell>
  );
}
