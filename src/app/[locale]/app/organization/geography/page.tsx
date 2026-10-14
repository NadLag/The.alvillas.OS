import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import {
  GeographyAuthorizationError,
  listGeography
} from "@/modules/organization/application/geography-service";
import { organizationActorContextFromSession } from "@/modules/organization/application/organization-access";
import {
  CityArchiveForm,
  CityCreateForm,
  RegionArchiveForm,
  RegionCreateForm
} from "@/modules/organization/ui/geography-forms";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

export default async function GeographyPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = await organizationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Organization.geography");
  let geography = null;
  let denied = false;

  try {
    geography = await listGeography(ctx);
  } catch (error) {
    if (error instanceof GeographyAuthorizationError) {
      denied = true;
    } else {
      throw error;
    }
  }

  const labels = {
    archive: t("form.archive"),
    archived: t("messages.archived"),
    cityCountry: t("fields.cityCountry"),
    cityName: t("fields.cityName"),
    cityRegion: t("fields.cityRegion"),
    cityTimezone: t("fields.cityTimezone"),
    conflict: t("messages.conflict"),
    forbidden: t("messages.forbidden"),
    generic: t("messages.generic"),
    noRegion: t("fields.noRegion"),
    notFound: t("messages.notFound"),
    regionCode: t("fields.regionCode"),
    regionDescription: t("fields.regionDescription"),
    regionName: t("fields.regionName"),
    saveCity: t("form.saveCity"),
    saveRegion: t("form.saveRegion"),
    saved: t("messages.saved"),
    saving: t("form.saving"),
    sortOrder: t("fields.sortOrder"),
    unauthorized: t("messages.unauthorized"),
    validation: t("messages.validation")
  };

  return (
    <AdminShell className="resource-page" testId="geography-page">
      <ShellHeader
        actions={
          <Link className="secondary-button" href={`/${appLocale}/app/organization`}>
            {t("backToOrganization")}
          </Link>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      {denied || !geography ? (
        <section className="workspace-main" data-testid="geography-denied">
          <p className="panel-label">{t("denied.title")}</p>
          <p>{t("denied.subtitle")}</p>
        </section>
      ) : (
        <div className="resource-layout">
          <section className="workspace-main" data-testid="geography-summary">
            <div className="section-heading">
              <p className="panel-label">{t("regions.title")}</p>
              <span data-testid="geography-region-count">{geography.regions.length}</span>
            </div>
            {geography.regions.length > 0 ? (
              <div className="data-list" data-testid="region-list">
                {geography.regions.map((region) => (
                  <article className="data-row" data-testid="region-row" key={region.id}>
                    <div>
                      <p className="row-title">{region.name}</p>
                      <p className="row-subtitle">
                        {region.code ?? t("regions.noCode")} - {t("regions.cityCount", { count: region.cityCount })} -{" "}
                        {t("regions.propertyCount", { count: region.propertyCount })}
                      </p>
                    </div>
                    {region.cityCount === 0 && region.propertyCount === 0 ? (
                      <RegionArchiveForm labels={labels} locale={appLocale} region={region} />
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state-panel">{t("regions.empty")}</p>
            )}

            <div className="section-heading">
              <p className="panel-label">{t("cities.title")}</p>
              <span data-testid="geography-city-count">{geography.cities.length}</span>
            </div>
            {geography.cities.length > 0 ? (
              <div className="data-list" data-testid="city-list">
                {geography.cities.map((city) => (
                  <article className="data-row" data-testid="city-row" key={city.id}>
                    <div>
                      <p className="row-title">{city.name}</p>
                      <p className="row-subtitle">
                        {city.regionName ?? t("fields.noRegion")} - {city.countryCode} - {city.timezone} -{" "}
                        {t("cities.propertyCount", { count: city.propertyCount })}
                      </p>
                    </div>
                    {city.propertyCount === 0 ? (
                      <CityArchiveForm city={city} labels={labels} locale={appLocale} />
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state-panel">{t("cities.empty")}</p>
            )}
          </section>

          <aside className="workspace-side" aria-label={t("forms.label")}>
            <p className="panel-label">{t("forms.region")}</p>
            <RegionCreateForm labels={labels} locale={appLocale} />
            <p className="panel-label">{t("forms.city")}</p>
            <CityCreateForm labels={labels} locale={appLocale} regions={geography.regions} />
          </aside>
        </div>
      )}
    </AdminShell>
  );
}
