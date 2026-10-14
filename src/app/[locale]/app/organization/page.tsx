import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import {
  organizationActorContextFromSession,
  OrganizationAuthorizationError
} from "@/modules/organization/application/organization-access";
import { getOrganizationSettings } from "@/modules/organization/application/organization-service";
import { OrganizationSettingsForm } from "@/modules/organization/ui/organization-settings-form";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

export default async function OrganizationPage({
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

  const t = await getTranslations("Organization");
  let settings = null;
  let denied = false;

  try {
    settings = await getOrganizationSettings(ctx);
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError) {
      denied = true;
    } else {
      throw error;
    }
  }

  return (
    <AdminShell className="resource-page" testId="organization-page">
      <ShellHeader
        actions={
          <div className="button-row">
            <Link className="secondary-button" href={`/${appLocale}/app/organization/geography`}>
              {t("geographyLink")}
            </Link>
            <Link className="secondary-button" href={`/${appLocale}/app`}>
              {t("backToWorkspace")}
            </Link>
          </div>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      {denied || !settings ? (
        <section className="workspace-main" data-testid="organization-denied">
          <p className="panel-label">{t("denied.title")}</p>
          <p>{t("denied.subtitle")}</p>
        </section>
      ) : (
        <div className="resource-layout">
          <section className="workspace-main">
            <div className="section-heading">
              <p className="panel-label">{t("profileLabel")}</p>
              <span data-testid="organization-base-currency-summary">{settings.baseCurrency}</span>
            </div>
            <dl className="detail-grid">
              <div>
                <dt>{t("fields.brandName")}</dt>
                <dd data-testid="organization-brand-name-summary">{settings.brandName}</dd>
              </div>
              <div>
                <dt>{t("fields.legalName")}</dt>
                <dd>{settings.legalName ?? t("notProvided")}</dd>
              </div>
              <div>
                <dt>{t("fields.defaultLocale")}</dt>
                <dd>{settings.defaultLocale.toUpperCase()}</dd>
              </div>
              <div>
                <dt>{t("fields.timezone")}</dt>
                <dd>{settings.timezone}</dd>
              </div>
              <div>
                <dt>{t("fields.supportEmail")}</dt>
                <dd data-testid="organization-support-email-summary">{settings.supportEmail ?? t("notProvided")}</dd>
              </div>
              <div>
                <dt>{t("fields.websiteUrl")}</dt>
                <dd>{settings.websiteUrl ?? t("notProvided")}</dd>
              </div>
            </dl>
            {settings.baseCurrencyLocked ? (
              <p className="field-hint" data-testid="organization-base-currency-locked">
                {t("baseCurrencyLocked")}
              </p>
            ) : null}
          </section>

          <aside className="workspace-side" aria-label={t("settingsLabel")}>
            <p className="panel-label">{t("settingsLabel")}</p>
            <OrganizationSettingsForm
              labels={{
                accentColor: t("fields.accentColor"),
                baseCurrency: t("fields.baseCurrency"),
                brandName: t("fields.brandName"),
                countryCode: t("fields.countryCode"),
                currencyLocked: t("messages.currencyLocked"),
                defaultLocale: t("fields.defaultLocale"),
                fiscalYearStartMonth: t("fields.fiscalYearStartMonth"),
                forbidden: t("messages.forbidden"),
                generic: t("messages.generic"),
                legalName: t("fields.legalName"),
                logoUrl: t("fields.logoUrl"),
                name: t("fields.name"),
                notFound: t("messages.notFound"),
                primaryColor: t("fields.primaryColor"),
                save: t("form.save"),
                saved: t("messages.saved"),
                saving: t("form.saving"),
                supportEmail: t("fields.supportEmail"),
                supportPhone: t("fields.supportPhone"),
                timezone: t("fields.timezone"),
                unauthorized: t("messages.unauthorized"),
                validation: t("messages.validation"),
                websiteUrl: t("fields.websiteUrl")
              }}
              locale={appLocale}
              settings={settings}
            />
          </aside>
        </div>
      )}
    </AdminShell>
  );
}
