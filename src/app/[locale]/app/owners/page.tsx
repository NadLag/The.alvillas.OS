import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { listOwners } from "@/modules/core/application/core-service";
import { OwnerCreateForm } from "@/modules/core/ui/core-forms";
import { OwnerRegisterTable } from "@/modules/core/ui/core-tables";
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

  const [t, dsnT, owners] = await Promise.all([
    getTranslations("Core"),
    getTranslations("DesignSystem"),
    listOwners(ctx)
  ]);
  const ownerRows = owners.map((owner) => ({
    id: owner.id,
    contact: owner.email ?? owner.phone ?? t("common.noContact"),
    displayName: owner.displayName,
    href: `/${appLocale}/app/owners/${owner.id}`,
    propertyCountLabel: t("owners.propertyCount", { count: owner.propertyCount })
  }));

  return (
    <AdminShell className="resource-page" testId="owners-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("common.backToWorkspace")}
        </Link>
        }
        eyebrow={t("owners.eyebrow")}
        subtitle={t("owners.subtitle")}
        title={t("owners.title")}
      />

      <div className="resource-layout">
        <section className="workspace-main">
          <div className="section-heading">
            <p className="panel-label">{t("owners.listLabel")}</p>
            <span data-testid="owner-count">{t("owners.count", { count: owners.length })}</span>
          </div>
          {owners.length === 0 ? <EmptyState testId="owners-empty" tone="motif">{t("owners.empty")}</EmptyState> : null}
          <OwnerRegisterTable
            labels={{
              contact: dsnT("dataTable.contact"),
              empty: dsnT("dataTable.empty"),
              exportCsv: dsnT("dataTable.exportCsv"),
              name: dsnT("dataTable.name"),
              properties: dsnT("dataTable.properties"),
              rows: dsnT("dataTable.rows"),
              saveView: dsnT("dataTable.saveView"),
              search: dsnT("dataTable.search"),
              viewName: dsnT("dataTable.viewName")
            }}
            rows={ownerRows}
          />
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
              representativeSection: t("owners.form.representativeSection"),
              representativeDisplayName: t("owners.form.representativeDisplayName"),
              representativeEmail: t("owners.form.representativeEmail"),
              representativePhone: t("owners.form.representativePhone"),
              representativeRelationship: t("owners.form.representativeRelationship"),
              representativeAccessNotes: t("owners.form.representativeAccessNotes"),
              representativeValidFrom: t("owners.form.representativeValidFrom"),
              representativeValidTo: t("owners.form.representativeValidTo"),
              payoutSection: t("owners.form.payoutSection"),
              payoutLabel: t("owners.form.payoutLabel"),
              payoutMethodType: t("owners.form.payoutMethodType"),
              payoutAccountHolderName: t("owners.form.payoutAccountHolderName"),
              payoutCurrency: t("owners.form.payoutCurrency"),
              payoutCountryCode: t("owners.form.payoutCountryCode"),
              payoutDetails: t("owners.form.payoutDetails"),
              payoutIsDefault: t("owners.form.payoutIsDefault"),
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
    </AdminShell>
  );
}
