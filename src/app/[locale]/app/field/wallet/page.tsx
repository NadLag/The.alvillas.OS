import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FieldShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { authorizeCollection } from "@/platform/authz/authorize";
import { FieldWallet } from "@/platform/offline/field-wallet";
import { FieldLanguage } from "@/platform/offline/field-language";
import { FieldPwa } from "@/platform/offline/field-pwa";

export const dynamic = "force-dynamic";
export default async function FieldWalletPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const session = await auth(); if (session?.user?.securitySetupRequired) redirect(`/${locale}/app/security`);
  const ctx = await identityActorContextFromSession(session); if (!ctx) redirect(`/${locale}/login?surface=field`);
  if (!authorizeCollection(ctx.authContext, "view", "wallet")) notFound();
  const [t, field] = await Promise.all([getTranslations("FieldWallet"), getTranslations("Field")]);
  return <FieldShell className="field-page" testId="field-wallet-page"><ShellHeader eyebrow={field("eyebrow")} title={t("title")} subtitle={t("subtitle")}
    actions={<Link className="secondary-button" href={`/${locale}/app/field`}>{t("back")}</Link>} />
    <FieldLanguage locale={locale} path="/app/field/wallet" /><FieldPwa organizationId={ctx.organizationId} userId={ctx.actorId} />
    <FieldWallet scope={{ organizationId: ctx.organizationId, userId: ctx.actorId }} locale={locale} />
  </FieldShell>;
}
