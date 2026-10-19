import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { getInvitationProfile, listIdentityDashboard, IdentityConflictError, IdentityNotFoundError } from "@/modules/identity/application/identity-service";
import { IdentityAuthorizationError } from "@/modules/identity/application/identity-access";
import { invitationInputSchema } from "@/modules/identity/domain/identity";
import { authorize } from "@/platform/authz/authorize";
import { IdentityAdmin } from "@/modules/identity/ui/identity-admin";
import { SecurityPanel } from "@/modules/identity/ui/security-panel";
import { auth } from "@/platform/auth/session";
import { formatDate, formatDateTime } from "@/i18n/format";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function IdentityPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ personId?: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  if (session?.user?.securitySetupRequired) redirect(`/${appLocale}/app/security`);
  const ctx = await identityActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }
  const requestedPersonId = (await searchParams).personId;
  if (requestedPersonId && !invitationInputSchema.shape.personId.safeParse(requestedPersonId).success) notFound();
  let selectedProfile: Awaited<ReturnType<typeof getInvitationProfile>> | null = null;
  if (requestedPersonId) {
    try { selectedProfile = await getInvitationProfile(ctx, requestedPersonId); }
    catch (error) { if (error instanceof IdentityConflictError || error instanceof IdentityNotFoundError || error instanceof IdentityAuthorizationError) notFound(); throw error; }
  }

  const [t, dashboard] = await Promise.all([
    getTranslations("Identity"),
    listIdentityDashboard(ctx)
  ]);
  const dates = [
    ...dashboard.assignments.map((assignment) => assignment.validTo),
    ...dashboard.accounts.flatMap((account) => [
      ...account.recentSessions.flatMap((session) => [session.lastSeenAt, session.expiresAt]),
      ...account.devices.map((device) => device.lastSeenAt),
      ...account.credentials.map((credential) => credential.expiresAt)
    ])
  ].filter((value): value is Date => value !== null);
  const dateLabels = Object.fromEntries(dates.map((date) => [date.toISOString(), formatDate(appLocale, date)]));
  const invitationProfiles = dashboard.people.filter(person => !person.accountCount && (["view", "create", "edit"] as const).every(action => authorize(ctx.authContext, action, { type: "identity", organizationId: ctx.organizationId, id: person.id })));
  const choices = invitationProfiles.map(person => ({ id: person.id, displayName: person.displayName, email: person.email, phone: person.phone, preferredLocale: person.preferredLocale, accountCount: person.accountCount }));
  if (selectedProfile && !choices.some(person => person.id === selectedProfile.id)) choices.unshift(selectedProfile);

  return (
    <AdminShell className="resource-page" testId="identity-page">
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
      <SecurityPanel
        signInHref={`/${appLocale}/login`}
        labels={{
          title: t("security.title"),
          subtitle: t("security.subtitle"),
          startTotp: t("security.startTotp"),
          confirmTotp: t("security.confirmTotp"),
          totpCode: t("security.totpCode"),
          totpSecret: t("security.totpSecret"),
          totpInvalid: t("security.totpInvalid"),
          recoveryCodes: t("security.recoveryCodes"),
          registerPasskey: t("security.registerPasskey"),
          passkeyReady: t("security.passkeyReady"),
          signInAgain: t("security.signInAgain"),
          validation: t("forms.validation"),
          generic: t("forms.generic"),
          unauthorized: t("forms.unauthorized"),
          forbidden: t("forms.forbidden")
        }}
      />
      <IdentityAdmin
        dateLabels={dateLabels}
        accounts={dashboard.accounts}
        assignments={dashboard.assignments}
        duplicateContacts={dashboard.duplicateContacts}
        invitations={dashboard.invitations.map((invitation) => ({
          ...invitation,
          expiresAtLabel: formatDateTime(appLocale, invitation.expiresAt)
        }))}
        people={dashboard.people}
        invitationProfiles={choices}
        initialPersonId={selectedProfile?.id}
        permissions={dashboard.permissions}
        roles={dashboard.roles}
        simulations={dashboard.simulations}
        labels={{
          createInvitation: t("createInvitation"),
          invitationProfile: t("invitationProfile"),
          newInvitationProfile: t("newInvitationProfile"),
          people: t("people"),
          createPerson: t("createPerson"),
          duplicateContacts: t("duplicateContacts"),
          noDuplicateContacts: t("noDuplicateContacts"),
          displayName: t("displayName"),
          email: t("email"),
          phone: t("phone"),
          preferredLocale: t("preferredLocale"),
          accountCount: t("accountCount"),
          openInvitations: t("openInvitations"),
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
          savePerson: t("savePerson"),
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
          conditionStartsAt: t("conditionStartsAt"),
          conditionEndsAt: t("conditionEndsAt"),
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
          devices: t("devices"),
          credentials: t("credentials"),
          activeDevices: t("activeDevices"),
          lastSeen: t("lastSeen"),
          revokeSession: t("revokeSession"),
          revokeDevice: t("revokeDevice"),
          revokeCredential: t("revokeCredential"),
          passkeys: t("passkeys"),
          suspend: t("suspend"),
          reactivate: t("reactivate"),
          deactivate: t("deactivate"),
          resetPin: t("resetPin"),
          newPin: t("newPin"),
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
          personCreated: t("forms.personCreated"),
          personUpdated: t("forms.personUpdated"),
          assignmentCreated: t("forms.assignmentCreated"),
          successCreated: t("forms.created"),
          successRecovery: t("forms.recoveryIssued"),
          successPinReset: t("forms.pinReset"),
          validation: t("forms.validation"),
          forbidden: t("forms.forbidden"),
          conflict: t("forms.conflict"),
          generic: t("forms.generic")
        }}
        locale={appLocale}
      />
    </AdminShell>
  );
}
