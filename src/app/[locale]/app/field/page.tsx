import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FieldShell, ShellHeader } from "@/design-system/shells";
import { FieldPwa } from "@/platform/offline/field-pwa";
import { FieldLanguage } from "@/platform/offline/field-language";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { pullFieldWork } from "@/modules/reservations/application/field-pull-service";
import { fieldPullInputSchema } from "@/modules/reservations/domain/field-pull";
import { FieldJobs } from "@/platform/offline/field-jobs";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";
import { authorizeCollection } from "@/platform/authz/authorize";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function FieldTasksPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  if (session?.user?.id && session.user.securitySetupRequired) redirect(`/${appLocale}/app/security`);
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login?surface=field`);
  }
  if (!authorizeCollection(ctx.authContext, "view", "task")) notFound();

  const [t, work] = await Promise.all([getTranslations("Field"), pullFieldWork(ctx, fieldPullInputSchema.parse({
    organization_id: ctx.organizationId, actor_user_id: ctx.actorId, mode: "assigned"
  }))]);

  return (
    <FieldShell className="field-page" testId="field-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("backToWorkspace")}
        </Link>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      <FieldLanguage locale={appLocale} path="/app/field" />
      {authorizeCollection(ctx.authContext, "validate", "task") ? <Link className="secondary-button" data-testid="field-proxy-entry"
        href={`/${appLocale}/app/field/validate`}>{(await getTranslations("FieldProxy"))("title")}</Link> : null}
      {authorizeCollection(ctx.authContext, "view", "wallet") ? <Link className="secondary-button" data-testid="field-wallet-entry" href={`/${appLocale}/app/field/wallet`}>{(await getTranslations("FieldWallet"))("title")}</Link> : null}
      <FieldPwa organizationId={ctx.organizationId} userId={ctx.actorId} />
      <FieldJobs scope={{ organizationId: ctx.organizationId, userId: ctx.actorId }} locale={appLocale} initial={work.tasks} />
    </FieldShell>
  );
}
