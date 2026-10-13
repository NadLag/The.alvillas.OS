import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { listIdentityDashboard } from "@/modules/identity/application/identity-service";
import { IdentityAdmin } from "@/modules/identity/ui/identity-admin";
import { SecurityPanel } from "@/modules/identity/ui/security-panel";
import { auth } from "@/platform/auth/session";
import { formatDateTime } from "@/i18n/format";
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
        assignments={dashboard.assignments}
        invitations={dashboard.invitations.map((invitation) => ({
          ...invitation,
          expiresAtLabel: formatDateTime(appLocale, invitation.expiresAt)
        }))}
        permissions={dashboard.permissions}
        roles={dashboard.roles}
        simulations={dashboard.simulations}
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
          roleCatalog: t("roleCatalog"),
          createCustomRole: t("createCustomRole"),
          editRole: t("editRole"),
          roleKey: t("roleKey"),
          roleName: t("roleName"),
          description: t("description"),
          permissions: t("permissions"),
          saveRole: t("saveRole"),
          createRole: t("createRole"),
          permissionCatalog: t("permissionCatalog"),
          assignmentWorkflow: t("assignmentWorkflow"),
          assignRole: t("assignRole"),
          account: t("account"),
          scopeId: t("scopeId"),
          conditions: t("conditions"),
          assignedToMe: t("assignedToMe"),
          statuses: t("statuses"),
          maxAmount: t("maxAmount"),
          validFrom: t("validFrom"),
          validTo: t("validTo"),
          compensationRef: t("compensationRef"),
          activeAssignments: t("activeAssignments"),
          systemRole: t("systemRole"),
          customRole: t("customRole"),
          permissionCount: t("permissionCount"),
          assignmentCount: t("assignmentCount"),
          permissionSimulator: t("permissionSimulator"),
          canSee: t("canSee"),
          cannotSee: t("cannotSee"),
          noSimulatorRows: t("noSimulatorRows"),
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
          coHost: t("rolesList.coHost"),
          operationsManager: t("rolesList.operationsManager"),
          propertyManager: t("rolesList.propertyManager"),
          housekeeper: t("rolesList.housekeeper"),
          poolTechnician: t("rolesList.poolTechnician"),
          gardener: t("rolesList.gardener"),
          maintenance: t("rolesList.maintenance"),
          chef: t("rolesList.chef"),
          driver: t("rolesList.driver"),
          qaInspector: t("rolesList.qaInspector"),
          accountant: t("rolesList.accountant"),
          procurement: t("rolesList.procurement"),
          guestExperience: t("rolesList.guestExperience"),
          revenueManager: t("rolesList.revenueManager"),
          regionalManager: t("rolesList.regionalManager"),
          contractor: t("rolesList.contractor"),
          ownerRepresentative: t("rolesList.ownerRepresentative"),
          temporaryWorker: t("rolesList.temporaryWorker"),
          organization: t("organization"),
          region: t("scopes.region"),
          city: t("scopes.city"),
          property: t("scopes.property"),
          ownerScope: t("scopes.owner"),
          reservation: t("scopes.reservation"),
          job: t("scopes.job"),
          service: t("scopes.service"),
          financialRecord: t("scopes.financialRecord"),
          wallet: t("scopes.wallet"),
          fieldTeam: t("scopes.fieldTeam"),
          roleCreated: t("forms.roleCreated"),
          roleUpdated: t("forms.roleUpdated"),
          assignmentCreated: t("forms.assignmentCreated"),
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
