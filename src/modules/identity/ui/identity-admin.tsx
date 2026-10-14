"use client";

import { useActionState, useState, useTransition } from "react";
import { formatDate } from "@/i18n/format";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import {
  assignRoleAction,
  createCustomRoleAction,
  createInvitationAction,
  createPersonProfileAction,
  deactivateAccountAction,
  issueRecoveryCodeAction,
  reactivateAccountAction,
  resetPinAction,
  revokeCredentialAction,
  revokeDeviceAction,
  revokeSessionAction,
  suspendAccountAction,
  updatePersonProfileAction,
  updateCustomRoleAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";
import type { AccountPermissionSimulation } from "@/modules/identity/application/identity-service";
import type {
  IdentityAccountSummary,
  DuplicateContactSummary,
  InvitationSummary,
  PermissionCatalogSummary,
  PersonProfileSummary,
  RoleAssignmentSummary,
  RoleCatalogSummary
} from "@/modules/identity/infrastructure/identity-repository";

type IdentityAdminProps = {
  locale: string;
  people: PersonProfileSummary[];
  duplicateContacts: DuplicateContactSummary[];
  accounts: IdentityAccountSummary[];
  invitations: Array<InvitationSummary & { expiresAtLabel: string }>;
  roles: RoleCatalogSummary[];
  permissions: PermissionCatalogSummary[];
  assignments: RoleAssignmentSummary[];
  simulations: AccountPermissionSimulation[];
  labels: {
    createInvitation: string;
    people: string;
    createPerson: string;
    duplicateContacts: string;
    noDuplicateContacts: string;
    displayName: string;
    email: string;
    phone: string;
    preferredLocale: string;
    accountCount: string;
    openInvitations: string;
    role: string;
    scope: string;
    expires: string;
    invite: string;
    invitationCode: string;
    accounts: string;
    roleCatalog: string;
    createCustomRole: string;
    editRole: string;
    roleKey: string;
    roleName: string;
    description: string;
    permissions: string;
    saveRole: string;
    savePerson: string;
    createRole: string;
    permissionCatalog: string;
    assignmentWorkflow: string;
    assignRole: string;
    account: string;
    scopeId: string;
    conditions: string;
    assignedToMe: string;
    statuses: string;
    maxAmount: string;
    conditionStartsAt: string;
    conditionEndsAt: string;
    validFrom: string;
    validTo: string;
    compensationRef: string;
    activeAssignments: string;
    systemRole: string;
    customRole: string;
    permissionCount: string;
    assignmentCount: string;
    permissionSimulator: string;
    canSee: string;
    cannotSee: string;
    noSimulatorRows: string;
    pendingInvitations: string;
    noInvitations: string;
    status: string;
    roles: string;
    sessions: string;
    devices: string;
    credentials: string;
    activeDevices: string;
    lastSeen: string;
    revokeSession: string;
    revokeDevice: string;
    revokeCredential: string;
    passkeys: string;
    suspend: string;
    reactivate: string;
    deactivate: string;
    resetPin: string;
    newPin: string;
    recovery: string;
    recoveryCode: string;
    admin: string;
    finance: string;
    fieldStaff: string;
    owner: string;
    coHost: string;
    operationsManager: string;
    propertyManager: string;
    housekeeper: string;
    poolTechnician: string;
    gardener: string;
    maintenance: string;
    chef: string;
    driver: string;
    qaInspector: string;
    accountant: string;
    procurement: string;
    guestExperience: string;
    revenueManager: string;
    regionalManager: string;
    contractor: string;
    ownerRepresentative: string;
    temporaryWorker: string;
    organization: string;
    region: string;
    city: string;
    property: string;
    ownerScope: string;
    reservation: string;
    job: string;
    service: string;
    financialRecord: string;
    wallet: string;
    fieldTeam: string;
    roleCreated: string;
    roleUpdated: string;
    personCreated: string;
    personUpdated: string;
    assignmentCreated: string;
    successCreated: string;
    successRecovery: string;
    successPinReset: string;
    validation: string;
    forbidden: string;
    conflict: string;
    generic: string;
  };
};

const initialState: IdentityFormState = { status: "idle" };

function stateMessage(state: IdentityFormState, labels: IdentityAdminProps["labels"]): string | null {
  switch (state.messageKey) {
    case "created":
      return labels.successCreated;
    case "personCreated":
      return labels.personCreated;
    case "personUpdated":
      return labels.personUpdated;
    case "roleCreated":
      return labels.roleCreated;
    case "roleUpdated":
      return labels.roleUpdated;
    case "assignmentCreated":
      return labels.assignmentCreated;
    case "recoveryIssued":
      return labels.successRecovery;
    case "pinReset":
      return labels.successPinReset;
    case "validation":
      return labels.validation;
    case "forbidden":
      return labels.forbidden;
    case "conflict":
      return labels.conflict;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

function RecoveryForm({
  locale,
  userAccountId,
  labels
}: {
  locale: string;
  userAccountId: string;
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(
    issueRecoveryCodeAction.bind(null, locale, userAccountId),
    initialState
  );
  const message = stateMessage(state, labels);

  return (
    <form className="inline-form" action={action}>
      <button className="secondary-button" data-testid="issue-recovery-button" disabled={pending} type="submit">
        {labels.recovery}
      </button>
      {message ? <span className="inline-message">{message}</span> : null}
      {state.recoveryCode ? (
        <code className="copy-code" data-testid="recovery-code">
          {labels.recoveryCode}: {state.recoveryCode}
        </code>
      ) : null}
    </form>
  );
}

function ResetPinForm({
  locale,
  userAccountId,
  labels
}: {
  locale: string;
  userAccountId: string;
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(
    resetPinAction.bind(null, locale, userAccountId),
    initialState
  );
  const message = stateMessage(state, labels);

  return (
    <form className="inline-form pin-reset-form" action={action}>
      <label className="field compact-field">
        <span>{labels.newPin}</span>
        <input
          autoComplete="new-password"
          data-testid="reset-pin-input"
          inputMode="numeric"
          maxLength={6}
          name="pin"
          pattern="\d{6}"
          required
          type="password"
        />
      </label>
      <button className="secondary-button" data-testid="reset-pin-button" disabled={pending} type="submit">
        {labels.resetPin}
      </button>
      {message ? <span className="inline-message">{message}</span> : null}
    </form>
  );
}

const profileLocales = ["en", "fr", "ar"] as const;

function PersonCreateForm({
  locale,
  labels
}: {
  locale: string;
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(createPersonProfileAction.bind(null, locale), initialState);
  const message = stateMessage(state, labels);

  return (
    <form className="resource-form" action={action} data-testid="person-create-form">
      <div className="form-grid four">
        <label className="field">
          <span>{labels.displayName}</span>
          <input data-testid="person-display-name" name="displayName" required />
        </label>
        <label className="field">
          <span>{labels.email}</span>
          <input data-testid="person-email" name="email" type="email" />
        </label>
        <label className="field">
          <span>{labels.phone}</span>
          <input data-testid="person-phone" name="phone" type="tel" />
        </label>
        <label className="field">
          <span>{labels.preferredLocale}</span>
          <select data-testid="person-preferred-locale" name="preferredLocale" defaultValue="en">
            {profileLocales.map((profileLocale) => (
              <option key={profileLocale} value={profileLocale}>
                {profileLocale.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="person-create-submit" disabled={pending} type="submit">
        {labels.createPerson}
      </button>
    </form>
  );
}

function PersonEditForm({
  locale,
  person,
  labels
}: {
  locale: string;
  person: PersonProfileSummary;
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(
    updatePersonProfileAction.bind(null, locale, person.id),
    initialState
  );
  const message = stateMessage(state, labels);

  return (
    <form className="resource-form profile-edit-form" action={action} data-testid="person-edit-form">
      <div className="form-grid four">
        <label className="field">
          <span>{labels.displayName}</span>
          <input data-testid="edit-person-display-name" name="displayName" defaultValue={person.displayName} required />
        </label>
        <label className="field">
          <span>{labels.email}</span>
          <input name="email" defaultValue={person.email ?? ""} type="email" />
        </label>
        <label className="field">
          <span>{labels.phone}</span>
          <input name="phone" defaultValue={person.phone ?? ""} type="tel" />
        </label>
        <label className="field">
          <span>{labels.preferredLocale}</span>
          <select name="preferredLocale" defaultValue={person.preferredLocale}>
            {profileLocales.map((profileLocale) => (
              <option key={profileLocale} value={profileLocale}>
                {profileLocale.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
          {message}
        </p>
      ) : null}
      <button className="secondary-button" data-testid="person-edit-submit" disabled={pending} type="submit">
        {labels.savePerson}
      </button>
    </form>
  );
}

function PersonProfileList({
  people,
  locale,
  labels
}: {
  people: PersonProfileSummary[];
  locale: string;
  labels: IdentityAdminProps["labels"];
}) {
  return (
    <div className="identity-account-list">
      {people.map((person) => (
        <article className="identity-account-row person-profile-row" data-testid="person-profile-row" key={person.id}>
          <span>
            <strong>{person.displayName}</strong>
            <small>{person.email ?? person.phone ?? person.id}</small>
          </span>
          <span>
            <small>{labels.accountCount}</small>
            <strong>{person.accountCount}</strong>
          </span>
          <span>
            <small>{labels.openInvitations}</small>
            <strong>{person.openInvitationCount}</strong>
          </span>
          <span>
            <small>{labels.activeAssignments}</small>
            <strong>{person.activeAssignmentCount}</strong>
          </span>
          <details className="role-edit-details">
            <summary>{labels.savePerson}</summary>
            <PersonEditForm labels={labels} locale={locale} person={person} />
          </details>
        </article>
      ))}
    </div>
  );
}

function DuplicateContactList({
  duplicateContacts,
  labels
}: {
  duplicateContacts: DuplicateContactSummary[];
  labels: IdentityAdminProps["labels"];
}) {
  if (duplicateContacts.length === 0) {
    return <p className="empty-state">{labels.noDuplicateContacts}</p>;
  }

  return (
    <div className="identity-account-list">
      {duplicateContacts.map((duplicate) => (
        <article
          className="identity-account-row duplicate-contact-row"
          data-testid="duplicate-contact-row"
          key={`${duplicate.contactType}:${duplicate.value}`}
        >
          <span>
            <strong>{duplicate.value}</strong>
            <small>{duplicate.contactType}</small>
          </span>
          <span>
            <small>{labels.people}</small>
            <strong>{duplicate.displayNames.join(", ")}</strong>
          </span>
        </article>
      ))}
    </div>
  );
}

const roleLabelKey: Record<string, keyof IdentityAdminProps["labels"]> = {
  admin: "admin",
  finance: "finance",
  field_staff: "fieldStaff",
  owner: "owner",
  co_host: "coHost",
  operations_manager: "operationsManager",
  property_manager: "propertyManager",
  housekeeper: "housekeeper",
  pool_technician: "poolTechnician",
  gardener: "gardener",
  maintenance: "maintenance",
  chef: "chef",
  driver: "driver",
  qa_inspector: "qaInspector",
  accountant: "accountant",
  procurement: "procurement",
  guest_experience: "guestExperience",
  revenue_manager: "revenueManager",
  regional_manager: "regionalManager",
  contractor: "contractor",
  owner_representative: "ownerRepresentative",
  temporary_worker: "temporaryWorker"
};

function roleLabel(roleKey: string, labels: IdentityAdminProps["labels"]): string {
  const key = roleLabelKey[roleKey];

  return key ? labels[key] : roleKey;
}

function roleDisplayName(
  role: Pick<RoleCatalogSummary, "isSystem" | "key" | "name">,
  labels: IdentityAdminProps["labels"]
): string {
  return role.isSystem ? roleLabel(role.key, labels) : role.name;
}

const scopeLabelKey: Record<string, keyof IdentityAdminProps["labels"]> = {
  organization: "organization",
  region: "region",
  city: "city",
  property: "property",
  owner: "ownerScope",
  reservation: "reservation",
  job: "job",
  service: "service",
  financial_record: "financialRecord",
  wallet: "wallet",
  field_team: "fieldTeam"
};

const assignmentScopeTypes = [
  "organization",
  "region",
  "city",
  "property",
  "owner",
  "reservation",
  "job",
  "service",
  "financial_record",
  "wallet",
  "field_team"
];

function scopeLabel(scopeType: string, labels: IdentityAdminProps["labels"]): string {
  const key = scopeLabelKey[scopeType];

  return key ? labels[key] : scopeType;
}

function groupedPermissions(permissions: PermissionCatalogSummary[]): Array<{
  resource: string;
  permissions: PermissionCatalogSummary[];
}> {
  const groups = new Map<string, PermissionCatalogSummary[]>();

  for (const permission of permissions) {
    groups.set(permission.resource, [...(groups.get(permission.resource) ?? []), permission]);
  }

  return [...groups.entries()].map(([resource, group]) => ({ resource, permissions: group }));
}

function PermissionChecklist({
  permissions,
  selected,
  labels
}: {
  permissions: PermissionCatalogSummary[];
  selected: ReadonlySet<string>;
  labels: IdentityAdminProps["labels"];
}) {
  return (
    <div className="permission-checklist" aria-label={labels.permissions}>
      {groupedPermissions(permissions).map((group) => (
        <fieldset className="permission-group" key={group.resource}>
          <legend>{group.resource.replaceAll("_", " ")}</legend>
          <div>
            {group.permissions.map((permission) => (
              <label key={permission.id}>
                <input
                  data-testid="custom-role-permission"
                  defaultChecked={selected.has(permission.key)}
                  name="permissionKeys"
                  type="checkbox"
                  value={permission.key}
                />
                <span>{permission.action}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function CustomRoleCreateForm({
  locale,
  permissions,
  labels
}: {
  locale: string;
  permissions: PermissionCatalogSummary[];
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(createCustomRoleAction.bind(null, locale), initialState);
  const message = stateMessage(state, labels);

  return (
    <form className="resource-form role-management-form" action={action} data-testid="custom-role-create-form">
      <div className="form-grid three">
        <label className="field">
          <span>{labels.roleName}</span>
          <input data-testid="custom-role-name" name="name" required />
        </label>
        <label className="field">
          <span>{labels.roleKey}</span>
          <input data-testid="custom-role-key" name="key" pattern="[a-z][a-z0-9_]{2,63}" required />
        </label>
        <label className="field">
          <span>{labels.description}</span>
          <input data-testid="custom-role-description" name="description" />
        </label>
      </div>
      <PermissionChecklist labels={labels} permissions={permissions} selected={new Set()} />
      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="custom-role-submit" disabled={pending} type="submit">
        {labels.createRole}
      </button>
    </form>
  );
}

function CustomRoleEditForm({
  locale,
  role,
  permissions,
  labels
}: {
  locale: string;
  role: RoleCatalogSummary;
  permissions: PermissionCatalogSummary[];
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(
    updateCustomRoleAction.bind(null, locale, role.id),
    initialState
  );
  const message = stateMessage(state, labels);

  return (
    <form className="resource-form role-management-form" action={action} data-testid="custom-role-edit-form">
      <input name="key" type="hidden" value={role.key} />
      <div className="form-grid two">
        <label className="field">
          <span>{labels.roleName}</span>
          <input data-testid="edit-custom-role-name" name="name" required defaultValue={role.name} />
        </label>
        <label className="field">
          <span>{labels.description}</span>
          <input name="description" defaultValue={role.description ?? ""} />
        </label>
      </div>
      <PermissionChecklist labels={labels} permissions={permissions} selected={new Set(role.permissionKeys)} />
      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
          {message}
        </p>
      ) : null}
      <button className="secondary-button" data-testid="edit-custom-role-submit" disabled={pending} type="submit">
        {labels.saveRole}
      </button>
    </form>
  );
}

function RoleAssignmentForm({
  locale,
  accounts,
  roles,
  labels
}: {
  locale: string;
  accounts: IdentityAccountSummary[];
  roles: RoleCatalogSummary[];
  labels: IdentityAdminProps["labels"];
}) {
  const [state, action, pending] = useActionState(assignRoleAction.bind(null, locale), initialState);
  const message = stateMessage(state, labels);

  return (
    <form className="resource-form role-assignment-form" action={action}>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.account}</span>
          <select data-testid="assignment-account" name="userAccountId" required>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName} {account.email ? `- ${account.email}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{labels.role}</span>
          <select data-testid="assignment-role" name="roleId" required>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {roleDisplayName(role, labels)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{labels.scope}</span>
          <select data-testid="assignment-scope-type" name="scopeType" required>
            {assignmentScopeTypes.map((scopeType) => (
              <option key={scopeType} value={scopeType}>
                {scopeLabel(scopeType, labels)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-grid three">
        <label className="field">
          <span>{labels.scopeId}</span>
          <input data-testid="assignment-scope-id" name="scopeId" />
        </label>
        <label className="field">
          <span>{labels.validFrom}</span>
          <input name="validFrom" type="date" />
        </label>
        <label className="field">
          <span>{labels.validTo}</span>
          <input data-testid="assignment-valid-to" name="validTo" type="date" />
        </label>
      </div>
      <fieldset className="conditions-fieldset">
        <legend>{labels.conditions}</legend>
        <label>
          <input data-testid="assignment-assigned-to-me" name="assignedToMe" type="checkbox" />
          <span>{labels.assignedToMe}</span>
        </label>
        <label className="field">
          <span>{labels.statuses}</span>
          <input name="statuses" />
        </label>
        <label className="field">
          <span>{labels.maxAmount}</span>
          <input inputMode="decimal" name="maxAmount" />
        </label>
        <label className="field">
          <span>{labels.conditionStartsAt}</span>
          <input data-testid="assignment-condition-starts-at" name="conditionStartsAt" type="datetime-local" />
        </label>
        <label className="field">
          <span>{labels.conditionEndsAt}</span>
          <input data-testid="assignment-condition-ends-at" name="conditionEndsAt" type="datetime-local" />
        </label>
        <label className="field">
          <span>{labels.compensationRef}</span>
          <input name="compensationRef" />
        </label>
      </fieldset>
      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="assignment-submit" disabled={pending} type="submit">
        {labels.assignRole}
      </button>
    </form>
  );
}

function RoleAssignmentList({
  assignments,
  locale,
  labels
}: {
  assignments: RoleAssignmentSummary[];
  locale: AppLocale;
  labels: IdentityAdminProps["labels"];
}) {
  return (
    <div className="identity-account-list">
      {assignments.map((assignment) => (
        <article className="identity-account-row role-assignment-row" data-testid="role-assignment-row" key={assignment.id}>
          <span>
            <strong>{assignment.displayName}</strong>
            <small>{assignment.email ?? assignment.personId}</small>
          </span>
          <span>
            <small>{labels.role}</small>
            <strong>{assignment.roleName}</strong>
          </span>
          <span>
            <small>{labels.scope}</small>
            <strong>
              {scopeLabel(assignment.scopeType, labels)}
              {assignment.scopeId ? ` - ${assignment.scopeId}` : ""}
            </strong>
          </span>
          <span>
            <small>{labels.validTo}</small>
            <strong>{assignment.validTo ? formatDate(locale, assignment.validTo) : "-"}</strong>
          </span>
        </article>
      ))}
    </div>
  );
}

function PermissionCatalog({
  permissions
}: {
  permissions: PermissionCatalogSummary[];
}) {
  return (
    <div className="permission-catalog-list">
      {groupedPermissions(permissions).map((group) => (
        <article className="permission-catalog-group" data-testid="permission-catalog-group" key={group.resource}>
          <strong>{group.resource.replaceAll("_", " ")}</strong>
          <span>{group.permissions.map((permission) => permission.action).join(", ")}</span>
        </article>
      ))}
    </div>
  );
}

export function IdentityAdmin({
  locale,
  people,
  duplicateContacts,
  accounts,
  invitations,
  roles,
  permissions,
  assignments,
  simulations,
  labels
}: IdentityAdminProps) {
  const [state, formAction, pending] = useActionState(
    createInvitationAction.bind(null, locale),
    initialState
  );
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const message = stateMessage(state, labels);
  const appLocale = safeLocale(locale);

  return (
    <div className="identity-layout">
      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.createInvitation}</h2>
        </div>
        <form className="resource-form" action={formAction}>
          <div className="form-grid two">
            <label className="field">
              <span>{labels.displayName}</span>
              <input data-testid="invite-display-name" name="displayName" required />
            </label>
            <label className="field">
              <span>{labels.email}</span>
              <input data-testid="invite-email" name="email" type="email" />
            </label>
            <label className="field">
              <span>{labels.phone}</span>
              <input data-testid="invite-phone" name="phone" type="tel" />
            </label>
            <label className="field">
              <span>{labels.role}</span>
              <select data-testid="invite-role" name="roleKey" required>
                {roles.map((role) => (
                  <option key={role.id} value={role.key}>
                    {roleDisplayName(role, labels)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{labels.scope}</span>
              <select data-testid="invite-scope-type" name="scopeType">
                {assignmentScopeTypes.map((scopeType) => (
                  <option key={scopeType} value={scopeType}>
                    {scopeLabel(scopeType, labels)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{labels.scopeId}</span>
              <input data-testid="invite-scope-id" name="scopeId" />
            </label>
            <label className="field">
              <span>{labels.expires}</span>
              <input defaultValue="48" min="1" max="168" name="expiresInHours" type="number" />
            </label>
          </div>
          {message ? (
            <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
              {message}
            </p>
          ) : null}
          {state.inviteCode ? (
            <code className="copy-code" data-testid="invitation-code">
              {labels.invitationCode}: {state.inviteCode}
            </code>
          ) : null}
          <button className="primary-button" data-testid="invite-submit" disabled={pending} type="submit">
            {labels.invite}
          </button>
        </form>
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.people}</h2>
        </div>
        <div className="subsection-block">
          <p className="panel-label">{labels.createPerson}</p>
          <PersonCreateForm labels={labels} locale={locale} />
        </div>
        <PersonProfileList labels={labels} locale={locale} people={people} />
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.duplicateContacts}</h2>
        </div>
        <DuplicateContactList duplicateContacts={duplicateContacts} labels={labels} />
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.accounts}</h2>
        </div>
        <div className="identity-account-list">
          {accounts.map((account) => (
            <article className="identity-account-row identity-account-row-expanded" data-testid="identity-account-row" key={account.id}>
              <span>
                <strong>{account.displayName}</strong>
                <small>{account.email ?? account.phone}</small>
              </span>
              <span>
                <small>{labels.status}</small>
                <strong>{account.status}</strong>
              </span>
              <span>
                <small>{labels.roles}</small>
                <strong>{account.roles.map((role) => roleLabel(role, labels)).join(", ")}</strong>
              </span>
              <span>
                <small>{labels.sessions}</small>
                <strong>{account.activeSessionCount}</strong>
              </span>
              <span>
                <small>{labels.activeDevices}</small>
                <strong>{account.activeDeviceCount}</strong>
              </span>
              <span>
                <small>{labels.passkeys}</small>
                <strong>{account.passkeyCount}</strong>
              </span>
              <div className="identity-row-actions">
                {account.status === "ACTIVE" ? (
                  <button
                    className="secondary-button"
                    data-testid="suspend-account-button"
                    disabled={busyAccount === account.id}
                    onClick={() => {
                      setBusyAccount(account.id);
                      startTransition(() => {
                        void suspendAccountAction(locale, account.id).finally(() => {
                          setBusyAccount(null);
                        });
                      });
                    }}
                    type="button"
                  >
                    {labels.suspend}
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    data-testid="reactivate-account-button"
                    disabled={busyAccount === account.id}
                    onClick={() => {
                      setBusyAccount(account.id);
                      startTransition(() => {
                        void reactivateAccountAction(locale, account.id).finally(() => {
                          setBusyAccount(null);
                        });
                      });
                    }}
                    type="button"
                  >
                    {labels.reactivate}
                  </button>
                )}
                {account.status !== "DEACTIVATED" ? (
                  <button
                    className="secondary-button danger-button"
                    data-testid="deactivate-account-button"
                    disabled={busyAccount === account.id}
                    onClick={() => {
                      setBusyAccount(account.id);
                      startTransition(() => {
                        void deactivateAccountAction(locale, account.id).finally(() => {
                          setBusyAccount(null);
                        });
                      });
                    }}
                    type="button"
                  >
                    {labels.deactivate}
                  </button>
                ) : null}
                <RecoveryForm labels={labels} locale={locale} userAccountId={account.id} />
                <ResetPinForm labels={labels} locale={locale} userAccountId={account.id} />
              </div>
              <div className="identity-security-list" data-testid="identity-session-device-list">
                <div>
                  <strong>{labels.sessions}</strong>
                  {account.recentSessions.length === 0 ? (
                    <small>-</small>
                  ) : (
                    account.recentSessions.map((session) => (
                      <div className="identity-security-row" data-testid="identity-session-row" key={session.id}>
                        <span>
                          <small>{labels.lastSeen}</small>
                          <strong>{formatDate(appLocale, session.lastSeenAt)}</strong>
                        </span>
                        <span>
                          <small>{labels.expires}</small>
                          <strong>{formatDate(appLocale, session.expiresAt)}</strong>
                        </span>
                        <span>
                          <small>{labels.status}</small>
                          <strong>{session.revokedAt ? "REVOKED" : "ACTIVE"}</strong>
                        </span>
                        <button
                          className="secondary-button"
                          data-testid="revoke-session-button"
                          disabled={Boolean(session.revokedAt) || busyAccount === session.id}
                          onClick={() => {
                            setBusyAccount(session.id);
                            startTransition(() => {
                              void revokeSessionAction(locale, session.id).finally(() => {
                                setBusyAccount(null);
                              });
                            });
                          }}
                          type="button"
                        >
                          {labels.revokeSession}
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <strong>{labels.devices}</strong>
                  {account.devices.length === 0 ? (
                    <small>-</small>
                  ) : (
                    account.devices.map((device) => (
                      <div className="identity-security-row" data-testid="identity-device-row" key={device.id}>
                        <span>
                          <small>{labels.devices}</small>
                          <strong>{device.label ?? device.deviceId}</strong>
                        </span>
                        <span>
                          <small>{labels.lastSeen}</small>
                          <strong>{device.lastSeenAt ? formatDate(appLocale, device.lastSeenAt) : "-"}</strong>
                        </span>
                        <span>
                          <small>{labels.status}</small>
                          <strong>{device.revokedAt ? "REVOKED" : "ACTIVE"}</strong>
                        </span>
                        <button
                          className="secondary-button"
                          data-testid="revoke-device-button"
                          disabled={Boolean(device.revokedAt) || busyAccount === device.id}
                          onClick={() => {
                            setBusyAccount(device.id);
                            startTransition(() => {
                              void revokeDeviceAction(locale, device.id).finally(() => {
                                setBusyAccount(null);
                              });
                            });
                          }}
                          type="button"
                        >
                          {labels.revokeDevice}
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <strong>{labels.credentials}</strong>
                  {account.credentials.length === 0 ? (
                    <small>-</small>
                  ) : (
                    account.credentials.map((credential) => (
                      <div className="identity-security-row" data-testid="identity-credential-row" key={credential.id}>
                        <span>
                          <small>{labels.credentials}</small>
                          <strong>{credential.label ?? credential.type}</strong>
                        </span>
                        <span>
                          <small>{labels.status}</small>
                          <strong>{credential.revokedAt ? "REVOKED" : "ACTIVE"}</strong>
                        </span>
                        <span>
                          <small>{labels.expires}</small>
                          <strong>{credential.expiresAt ? formatDate(appLocale, credential.expiresAt) : "-"}</strong>
                        </span>
                        <button
                          className="secondary-button"
                          data-testid="revoke-credential-button"
                          disabled={Boolean(credential.revokedAt) || busyAccount === credential.id}
                          onClick={() => {
                            setBusyAccount(credential.id);
                            startTransition(() => {
                              void revokeCredentialAction(locale, credential.id).finally(() => {
                                setBusyAccount(null);
                              });
                            });
                          }}
                          type="button"
                        >
                          {labels.revokeCredential}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.roleCatalog}</h2>
        </div>
        <div className="subsection-block">
          <p className="panel-label">{labels.createCustomRole}</p>
          <CustomRoleCreateForm labels={labels} locale={locale} permissions={permissions} />
        </div>
        <div className="identity-account-list">
          {roles.map((role) => (
            <article className="identity-account-row role-catalog-row" data-testid="role-catalog-row" key={role.id}>
              <span>
                <strong>{roleDisplayName(role, labels)}</strong>
                <small>
                  {role.isSystem ? labels.systemRole : labels.customRole} - {role.description ?? role.key}
                </small>
              </span>
              <span>
                <small>{labels.permissionCount}</small>
                <strong>{role.permissionCount}</strong>
              </span>
              <span>
                <small>{labels.assignmentCount}</small>
                <strong>{role.assignmentCount}</strong>
              </span>
              {!role.isSystem ? (
                <details className="role-edit-details">
                  <summary>{labels.editRole}</summary>
                  <CustomRoleEditForm
                    labels={labels}
                    locale={locale}
                    permissions={permissions}
                    role={role}
                  />
                </details>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.assignmentWorkflow}</h2>
        </div>
        <RoleAssignmentForm accounts={accounts} labels={labels} locale={locale} roles={roles} />
        <div className="subsection-block">
          <p className="panel-label">{labels.activeAssignments}</p>
          <RoleAssignmentList assignments={assignments} labels={labels} locale={appLocale} />
        </div>
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.permissionCatalog}</h2>
        </div>
        <PermissionCatalog permissions={permissions} />
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.permissionSimulator}</h2>
        </div>
        {simulations.length === 0 ? (
          <p className="empty-state">{labels.noSimulatorRows}</p>
        ) : (
          <div className="identity-account-list">
            {simulations.map((simulation) => (
              <article
                className="identity-account-row simulator-row"
                data-testid="permission-simulator-row"
                key={simulation.userAccountId}
              >
                <span>
                  <strong>{simulation.displayName}</strong>
                  <small>{simulation.roleLabels.map((role) => roleLabel(role, labels)).join(", ")}</small>
                </span>
                <span>
                  <small>{labels.canSee}</small>
                  <strong>{simulation.canSee.map((result) => result.label).join(", ") || "-"}</strong>
                </span>
                <span>
                  <small>{labels.cannotSee}</small>
                  <strong>{simulation.cannotSee.map((result) => result.label).join(", ") || "-"}</strong>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="detail-panel">
        <div className="section-heading">
          <h2>{labels.pendingInvitations}</h2>
        </div>
        {invitations.length === 0 ? (
          <p className="empty-state">{labels.noInvitations}</p>
        ) : (
          <div className="identity-account-list">
            {invitations.map((invitation) => (
              <article className="identity-account-row" key={invitation.id}>
                <span>
                  <strong>{invitation.personName}</strong>
                  <small>{invitation.email ?? invitation.phone}</small>
                </span>
                <span>
                  <small>{labels.role}</small>
                  <strong>{invitation.roleKey}</strong>
                </span>
                <span>
                  <small>{labels.expires}</small>
                  <strong>{invitation.expiresAtLabel}</strong>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
