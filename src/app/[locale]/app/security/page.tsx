import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { SecurityPanel } from "@/modules/identity/ui/security-panel";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);
  const session = await auth();
  if (!session?.user?.id) redirect(`/${appLocale}/login`);
  const t = await getTranslations("Identity");
  return (
    <AdminShell className="resource-page" testId="account-security-page">
      <ShellHeader eyebrow={t("security.title")} title={t("security.title")} subtitle={t(session.user.securitySetupRequired ? "security.requiredSubtitle" : "security.subtitle")}
        actions={<Link className="secondary-button" href={`/${appLocale}/app`}>{t("backToWorkspace")}</Link>} />
      <SecurityPanel signInHref={`/${appLocale}/login`} labels={{
        title: t("security.title"), subtitle: t("security.subtitle"), startTotp: t("security.startTotp"),
        confirmTotp: t("security.confirmTotp"), totpCode: t("security.totpCode"), totpSecret: t("security.totpSecret"),
        totpInvalid: t("security.totpInvalid"), recoveryCodes: t("security.recoveryCodes"), registerPasskey: t("security.registerPasskey"),
        passkeyReady: t("security.passkeyReady"), validation: t("forms.validation"), generic: t("forms.generic"),
        unauthorized: t("forms.unauthorized"), forbidden: t("forms.forbidden"), signInAgain: t("security.signInAgain")
      }} />
    </AdminShell>
  );
}
