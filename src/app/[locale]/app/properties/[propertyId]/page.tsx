import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { CoreNotFoundError, getProperty } from "@/modules/core/application/core-service";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function PropertyDetailPage({
  params
}: Readonly<{
  params: Promise<{ locale: string; propertyId: string }>;
}>) {
  const { locale, propertyId } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const parsedId = idSchema.safeParse(propertyId);

  if (!parsedId.success) {
    notFound();
  }

  const session = await auth();
  const ctx = coreActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Core");
  let property;

  try {
    property = await getProperty(ctx, parsedId.data);
  } catch (error) {
    if (error instanceof CoreNotFoundError) {
      notFound();
    }

    throw error;
  }

  return (
    <AdminShell className="resource-page" testId="property-detail-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app/properties`}>
          {t("properties.backToProperties")}
        </Link>
        }
        eyebrow={t("properties.detailEyebrow")}
        subtitle={t("properties.rowMeta", { city: property.city, type: property.propertyType })}
        title={property.name}
      />

      <section className="detail-panel">
        <dl className="detail-grid">
          <div>
            <dt>{t("properties.form.owner")}</dt>
            <dd data-testid="property-detail-owner">
              {property.owners.map((owner) => owner.displayName).join(", ")}
            </dd>
          </div>
          <div>
            <dt>{t("properties.form.bedrooms")}</dt>
            <dd>{property.bedrooms}</dd>
          </div>
          <div>
            <dt>{t("properties.form.bathrooms")}</dt>
            <dd>{property.bathrooms}</dd>
          </div>
          <div>
            <dt>{t("properties.form.maxGuests")}</dt>
            <dd>{property.maxGuests}</dd>
          </div>
          <div>
            <dt>{t("properties.form.timezone")}</dt>
            <dd>{property.timezone}</dd>
          </div>
          <div>
            <dt>{t("properties.statusLabel")}</dt>
            <dd>{t(`properties.status.${property.status}`)}</dd>
          </div>
          <div>
            <dt>{t("properties.form.hasPool")}</dt>
            <dd>{property.hasPool ? t("common.yes") : t("common.no")}</dd>
          </div>
          <div>
            <dt>{t("properties.form.hasGarden")}</dt>
            <dd>{property.hasGarden ? t("common.yes") : t("common.no")}</dd>
          </div>
          <div className="wide">
            <dt>{t("properties.form.amenities")}</dt>
            <dd>{property.amenities.length > 0 ? property.amenities.join(", ") : t("common.notProvided")}</dd>
          </div>
          <div className="wide">
            <dt>{t("properties.form.photoUrls")}</dt>
            <dd>{property.photoUrls.length > 0 ? property.photoUrls.join(", ") : t("common.notProvided")}</dd>
          </div>
        </dl>
      </section>
    </AdminShell>
  );
}
