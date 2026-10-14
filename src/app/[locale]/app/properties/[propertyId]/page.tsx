import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { CoreNotFoundError, getProperty, listOwners } from "@/modules/core/application/core-service";
import { PropertyOperatingProfileForm, PropertyOwnershipForm } from "@/modules/core/ui/core-forms";
import { authorize } from "@/platform/authz/authorize";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function shareLabel(shareBps: number): string {
  return `${(shareBps / 100).toFixed(2).replace(/\.00$/u, "")}%`;
}

function enabledLabel(value: boolean, yes: string, no: string): string {
  return value ? yes : no;
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
  const canEditOwnership = authorize(ctx.authContext, "edit", {
    type: "property",
    organizationId: ctx.organizationId,
    id: property.id,
    propertyId: property.id,
    city: property.cityId,
    region: property.regionId
  });
  const ownerOptions = canEditOwnership ? await listOwners(ctx) : [];

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
              {property.owners
                .map((owner) => `${owner.displayName} (${shareLabel(owner.shareBps)})`)
                .join(", ")}
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

      <section className="detail-panel">
        <p className="panel-label">{t("properties.operating.title")}</p>
        {property.operatingProfile ? (
          <>
            <dl className="detail-grid" data-testid="property-operating-profile">
              <div>
                <dt>{t("properties.operating.cleaning")}</dt>
                <dd>
                  {enabledLabel(property.operatingProfile.cleaningEnabled, t("common.yes"), t("common.no"))} ·{" "}
                  {t(`properties.operating.cadenceOptions.${property.operatingProfile.cleaningFrequency}`)}
                </dd>
              </div>
              <div>
                <dt>{t("properties.operating.inspection")}</dt>
                <dd>
                  {enabledLabel(property.operatingProfile.inspectionEnabled, t("common.yes"), t("common.no"))} ·{" "}
                  {t(`properties.operating.cadenceOptions.${property.operatingProfile.inspectionFrequency}`)}
                </dd>
              </div>
              <div>
                <dt>{t("properties.operating.poolService")}</dt>
                <dd>
                  {enabledLabel(property.operatingProfile.poolServiceEnabled, t("common.yes"), t("common.no"))} ·{" "}
                  {t(`properties.operating.cadenceOptions.${property.operatingProfile.poolServiceFrequency}`)}
                </dd>
              </div>
              <div>
                <dt>{t("properties.operating.gardenService")}</dt>
                <dd>
                  {enabledLabel(property.operatingProfile.gardenServiceEnabled, t("common.yes"), t("common.no"))} ·{" "}
                  {t(`properties.operating.cadenceOptions.${property.operatingProfile.gardenServiceFrequency}`)}
                </dd>
              </div>
              <div>
                <dt>{t("properties.operating.laundry")}</dt>
                <dd>{enabledLabel(property.operatingProfile.laundryManaged, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div>
                <dt>{t("properties.operating.linen")}</dt>
                <dd>{enabledLabel(property.operatingProfile.linenManaged, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div>
                <dt>{t("properties.operating.maintenance")}</dt>
                <dd>
                  {enabledLabel(property.operatingProfile.maintenanceTrackingEnabled, t("common.yes"), t("common.no"))} ·{" "}
                  {t(`properties.operating.cadenceOptions.${property.operatingProfile.preventiveMaintenanceFrequency}`)}
                </dd>
              </div>
              <div>
                <dt>{t("properties.operating.midStayCleaning")}</dt>
                <dd>
                  {enabledLabel(property.operatingProfile.midStayCleaningEnabled, t("common.yes"), t("common.no"))}
                  {property.operatingProfile.midStayCleaningRuleKey
                    ? ` · ${property.operatingProfile.midStayCleaningRuleKey}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>{t("properties.operating.breakfast")}</dt>
                <dd>{enabledLabel(property.operatingProfile.breakfastAvailable, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div>
                <dt>{t("properties.operating.chef")}</dt>
                <dd>{enabledLabel(property.operatingProfile.chefAvailable, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div>
                <dt>{t("properties.operating.transfers")}</dt>
                <dd>{enabledLabel(property.operatingProfile.transfersAvailable, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div>
                <dt>{t("properties.operating.groceries")}</dt>
                <dd>{enabledLabel(property.operatingProfile.groceriesAvailable, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div>
                <dt>{t("properties.operating.wellness")}</dt>
                <dd>{enabledLabel(property.operatingProfile.wellnessAvailable, t("common.yes"), t("common.no"))}</dd>
              </div>
              <div className="wide">
                <dt>{t("properties.operating.otherServices")}</dt>
                <dd>
                  {property.operatingProfile.otherServices.length > 0
                    ? property.operatingProfile.otherServices.join(", ")
                    : t("common.notProvided")}
                </dd>
              </div>
              <div className="wide">
                <dt>{t("properties.operating.automationNotes")}</dt>
                <dd>{property.operatingProfile.automationNotes ?? t("common.notProvided")}</dd>
              </div>
            </dl>
            {canEditOwnership ? (
              <PropertyOperatingProfileForm
                labels={{
                  automationNotes: t("properties.operating.automationNotes"),
                  breakfast: t("properties.operating.breakfast"),
                  cadence: t("properties.operating.cadence"),
                  cadenceOptions: {
                    NONE: t("properties.operating.cadenceOptions.NONE"),
                    ON_DEMAND: t("properties.operating.cadenceOptions.ON_DEMAND"),
                    BETWEEN_STAYS: t("properties.operating.cadenceOptions.BETWEEN_STAYS"),
                    DAILY: t("properties.operating.cadenceOptions.DAILY"),
                    WEEKLY: t("properties.operating.cadenceOptions.WEEKLY"),
                    MONTHLY: t("properties.operating.cadenceOptions.MONTHLY"),
                    CHECKIN: t("properties.operating.cadenceOptions.CHECKIN"),
                    CHECKOUT: t("properties.operating.cadenceOptions.CHECKOUT"),
                    CUSTOM_RULE: t("properties.operating.cadenceOptions.CUSTOM_RULE")
                  },
                  chef: t("properties.operating.chef"),
                  cleaning: t("properties.operating.cleaning"),
                  formTitle: t("properties.operating.formTitle"),
                  gardenService: t("properties.operating.gardenService"),
                  groceries: t("properties.operating.groceries"),
                  inspection: t("properties.operating.inspection"),
                  laundry: t("properties.operating.laundry"),
                  linen: t("properties.operating.linen"),
                  maintenance: t("properties.operating.maintenance"),
                  midStayCleaning: t("properties.operating.midStayCleaning"),
                  midStayRuleKey: t("properties.operating.midStayRuleKey"),
                  otherServices: t("properties.operating.otherServices"),
                  poolService: t("properties.operating.poolService"),
                  preventiveMaintenance: t("properties.operating.preventiveMaintenance"),
                  save: t("properties.operating.save"),
                  saved: t("properties.operating.saved"),
                  saving: t("common.saving"),
                  transfers: t("properties.operating.transfers"),
                  validation: t("forms.validation"),
                  unauthorized: t("forms.unauthorized"),
                  forbidden: t("forms.forbidden"),
                  notFound: t("forms.notFound"),
                  generic: t("forms.generic"),
                  wellness: t("properties.operating.wellness")
                }}
                locale={appLocale}
                profile={property.operatingProfile}
                propertyId={property.id}
              />
            ) : null}
          </>
        ) : (
          <p className="field-hint">{t("properties.operating.empty")}</p>
        )}
      </section>

      <section className="detail-panel">
        <p className="panel-label">{t("properties.ownership.title")}</p>
        <div className="ownership-summary" data-testid="property-ownership-summary">
          {property.owners.map((owner) => (
            <div className="ownership-summary-row" key={owner.id}>
              <span>{owner.displayName}</span>
              <strong>{shareLabel(owner.shareBps)}</strong>
              {owner.isPrimary ? <small>{t("properties.ownership.primary")}</small> : null}
            </div>
          ))}
        </div>
        {canEditOwnership ? (
          <PropertyOwnershipForm
            labels={{
              addOwner: t("properties.ownership.addOwner"),
              owner: t("properties.ownership.owner"),
              ownershipSection: t("properties.ownership.formTitle"),
              primary: t("properties.ownership.primary"),
              removeOwner: t("properties.ownership.removeOwner"),
              saved: t("properties.ownership.saved"),
              saveOwnership: t("properties.ownership.save"),
              sharePercent: t("properties.ownership.sharePercent"),
              shareTotal: t("properties.ownership.shareTotal"),
              shareTotalInvalid: t("properties.ownership.shareTotalInvalid"),
              saving: t("common.saving"),
              validation: t("forms.validation"),
              unauthorized: t("forms.unauthorized"),
              forbidden: t("forms.forbidden"),
              notFound: t("forms.notFound"),
              generic: t("forms.generic")
            }}
            locale={appLocale}
            ownerOptions={ownerOptions.map((owner) => ({ id: owner.id, displayName: owner.displayName }))}
            propertyId={property.id}
            shares={property.owners}
          />
        ) : null}
      </section>

      <section className="detail-panel">
        <p className="panel-label">{t("properties.onboardingProfile")}</p>
        {property.onboardingProfile ? (
          <dl className="detail-grid" data-testid="property-onboarding-profile">
            <div>
              <dt>{t("properties.form.headline")}</dt>
              <dd>{property.onboardingProfile.headline ?? t("common.notProvided")}</dd>
            </div>
            <div>
              <dt>{t("properties.photoCount")}</dt>
              <dd>{property.onboardingProfile.photoGallery.length}</dd>
            </div>
            <div className="wide">
              <dt>{t("properties.form.description")}</dt>
              <dd>{property.onboardingProfile.description ?? t("common.notProvided")}</dd>
            </div>
            <div className="wide">
              <dt>{t("properties.form.publicDirections")}</dt>
              <dd>{property.onboardingProfile.publicDirections ?? t("common.notProvided")}</dd>
            </div>
            <div className="wide">
              <dt>{t("properties.form.internalAccessNotes")}</dt>
              <dd>{property.onboardingProfile.internalAccessNotes ?? t("common.notProvided")}</dd>
            </div>
            <div className="wide">
              <dt>{t("properties.form.houseRules")}</dt>
              <dd>
                {property.onboardingProfile.houseRules.length > 0
                  ? property.onboardingProfile.houseRules.join(", ")
                  : t("common.notProvided")}
              </dd>
            </div>
            <div className="wide">
              <dt>{t("properties.form.onboardingNotes")}</dt>
              <dd>{property.onboardingProfile.onboardingNotes ?? t("common.notProvided")}</dd>
            </div>
          </dl>
        ) : (
          <p className="field-hint">{t("properties.noOnboardingProfile")}</p>
        )}
      </section>
    </AdminShell>
  );
}
