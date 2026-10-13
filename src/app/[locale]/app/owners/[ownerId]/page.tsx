import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import { CoreNotFoundError, getOwner } from "@/modules/core/application/core-service";
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
  const ctx = coreActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Core");
  let owner;

  try {
    owner = await getOwner(ctx, parsedId.data);
  } catch (error) {
    if (error instanceof CoreNotFoundError) {
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
    </AdminShell>
  );
}
