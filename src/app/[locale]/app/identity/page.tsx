import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { ensureStandardIdentitySetup, listIdentityDashboard } from "@/modules/identity/application/identity-service";
import { IdentityAdmin } from "@/modules/identity/ui/identity-admin";
import { SecurityPanel } from "@/modules/identity/ui/security-panel";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function IdentityPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = await identityActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await ensureStandardIdentitySetup(ctx.organizationId);
  const [t, dashboard] = await Promise.all([
    getTranslations("Identity"),
    listIdentityDashboard(ctx)
  ]);

  return (
    <section className="resource-page" data-testid="identity-page">
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
      <SecurityPanel
        labels={{
          title: t("security.title"),
          subtitle: t("security.subtitle"),
          startTotp: t("security.startTotp"),
          confirmTotp: t("security.confirmTotp"),
          totpCode: t("security.totpCode"),
          totpSecret: t("security.totpSecret"),
          recoveryCodes: t("security.recoveryCodes"),
          registerPasskey: t("security.registerPasskey"),
          passkeyReady: t("security.passkeyReady"),
          validation: t("forms.validation"),
          generic: t("forms.generic")
        }}
      />
      <IdentityAdmin
        accounts={dashboard.accounts}
        invitations={dashboard.invitations}
        labels={{
          createInvitation: t("createInvitation"),
          displayName: t("displayName"),
          email: t("email"),
          phone: t("phone"),
          role: t("role"),
          scope: t("scope"),
          expires: t("expires"),
          invite: t("invite"),
          invitationCode: t("invitationCode"),
          accounts: t("accounts"),
          pendingInvitations: t("pendingInvitations"),
          noInvitations: t("noInvitations"),
          status: t("status"),
          roles: t("roles"),
          sessions: t("sessions"),
          passkeys: t("passkeys"),
          suspend: t("suspend"),
          reactivate: t("reactivate"),
          recovery: t("recoveryAction"),
          recoveryCode: t("recoveryCode"),
          admin: t("rolesList.admin"),
          finance: t("rolesList.finance"),
          fieldStaff: t("rolesList.fieldStaff"),
          owner: t("rolesList.owner"),
          organization: t("organization"),
          successCreated: t("forms.created"),
          successRecovery: t("forms.recoveryIssued"),
          validation: t("forms.validation"),
          forbidden: t("forms.forbidden"),
          conflict: t("forms.conflict"),
          generic: t("forms.generic")
        }}
        locale={appLocale}
      />
    </section>
  );
}
