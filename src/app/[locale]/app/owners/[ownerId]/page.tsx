import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { CoreAuthorizationError, CoreNotFoundError, getOwner } from "@/modules/core/application/core-service";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function OwnerDetailPage({
  params
}: Readonly<{
  params: Promise<{ locale: string; ownerId: string }>;
}>) {
  const { locale, ownerId } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const parsedId = idSchema.safeParse(ownerId);

  if (!parsedId.success) {
    notFound();
  }

  const session = await auth();
  const ctx = await coreActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Core");
  let owner;

  try {
    owner = await getOwner(ctx, parsedId.data);
  } catch (error) {
    if (error instanceof CoreNotFoundError || error instanceof CoreAuthorizationError) {
      notFound();
    }

    throw error;
  }

  return (
    <AdminShell className="resource-page" testId="owner-detail-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app/owners`}>
          {t("owners.backToOwners")}
        </Link>
        }
        eyebrow={t("owners.detailEyebrow")}
        subtitle={owner.legalName ?? t("owners.noLegalName")}
        title={owner.displayName}
      />

      <section className="detail-panel">
        <dl className="detail-grid">
          <div>
            <dt>{t("owners.form.email")}</dt>
            <dd data-testid="owner-detail-email">{owner.email ?? t("common.notProvided")}</dd>
          </div>
          <div>
            <dt>{t("owners.form.phone")}</dt>
            <dd>{owner.phone ?? t("common.notProvided")}</dd>
          </div>
          <div>
            <dt>{t("owners.form.preferredLocale")}</dt>
            <dd>{owner.preferredLocale.toUpperCase()}</dd>
          </div>
          <div>
            <dt>{t("owners.properties")}</dt>
            <dd>{t("owners.propertyCount", { count: owner.propertyCount })}</dd>
          </div>
          <div className="wide">
            <dt>{t("owners.form.notes")}</dt>
            <dd>{owner.notes ?? t("common.notProvided")}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-panel">
        <div className="subsection-block">
          <p className="panel-label">{t("owners.representatives")}</p>
          {owner.representatives.length > 0 ? (
            <dl className="detail-grid" data-testid="owner-representatives">
              {owner.representatives.map((representative) => (
                <div key={representative.id} className="wide">
                  <dt>
                    {representative.displayName}
                    {representative.relationship ? ` - ${representative.relationship}` : ""}
                  </dt>
                  <dd>
                    {[representative.email, representative.phone, representative.status]
                      .filter(Boolean)
                      .join(" | ")}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="field-hint">{t("owners.noRepresentatives")}</p>
          )}
        </div>

        <div className="subsection-block">
          <p className="panel-label">{t("owners.payoutMethods")}</p>
          {owner.payoutMethods.length > 0 ? (
            <dl className="detail-grid" data-testid="owner-payout-methods">
              {owner.payoutMethods.map((method) => (
                <div key={method.id} className="wide">
                  <dt>
                    {method.label}
                    {method.isDefault ? ` - ${t("owners.defaultPayout")}` : ""}
                  </dt>
                  <dd>
                    {t("owners.maskedPayout", {
                      method: method.methodType,
                      account: method.maskedAccount,
                      currency: method.currency
                    })}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="field-hint">{t("owners.noPayoutMethods")}</p>
          )}
        </div>
      </section>
    </AdminShell>
  );
}
