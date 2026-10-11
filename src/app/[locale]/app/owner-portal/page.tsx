import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { defaultStatementPeriod } from "@/modules/owner-portal/domain/owner-statement";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { listOwnerPortalProperties } from "@/modules/owner-portal/application/owner-portal-service";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

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

  const [t, properties] = await Promise.all([
    getTranslations("OwnerPortal"),
    listOwnerPortalProperties(ctx)
  ]);
  const period = defaultStatementPeriod();
  const periodQuery = `from=${period.from}&to=${period.to}`;

  return (
    <section className="resource-page" data-testid="owner-portal-page">
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

      <section className="workspace-main">
        <div className="section-heading">
          <p className="panel-label">{t("propertiesLabel")}</p>
          <span data-testid="owner-property-count">
            {t("propertyCount", { count: properties.length })}
          </span>
        </div>
        {properties.length === 0 ? (
          <p className="empty-state" data-testid="owner-properties-empty">
            {t("empty")}
          </p>
        ) : (
          <div className="resource-list">
            {properties.map((property) => (
              <Link
                className="resource-row"
                data-testid="owner-property-row"
                href={`/${appLocale}/app/owner-portal/properties/${property.propertyId}?${periodQuery}`}
                key={property.propertyId}
              >
                <span>
                  <strong>{property.propertyName}</strong>
                  <small>{t("propertyMeta", { city: property.city, owner: property.ownerName })}</small>
                </span>
                <span>{t("openStatement")}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
