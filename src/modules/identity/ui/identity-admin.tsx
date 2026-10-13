"use client";

import { useActionState, useState, useTransition } from "react";
import { formatDate } from "@/i18n/format";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import {
  assignRoleAction,
  createCustomRoleAction,
  createInvitationAction,
  issueRecoveryCodeAction,
  reactivateAccountAction,
  suspendAccountAction,
  updateCustomRoleAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";
import type { AccountPermissionSimulation } from "@/modules/identity/application/identity-service";
import type {
  IdentityAccountSummary,
  InvitationSummary,
  PermissionCatalogSummary,
  RoleAssignmentSummary,
  RoleCatalogSummary
} from "@/modules/identity/infrastructure/identity-repository";

type IdentityAdminProps = {
  locale: string;
  accounts: IdentityAccountSummary[];
  invitations: Array<InvitationSummary & { expiresAtLabel: string }>;
  roles: RoleCatalogSummary[];
  permissions: PermissionCatalogSummary[];
  assignments: RoleAssignmentSummary[];
  simulations: AccountPermissionSimulation[];
  labels: {
    createInvitation: string;
    displayName: string;
    email: string;
    phone: string;
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
    passkeys: string;
    suspend: string;
    reactivate: string;
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
    assignmentCreated: string;
    successCreated: string;
    successRecovery: string;
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
    case "roleCreated":
      return labels.roleCreated;
    case "roleUpdated":
      return labels.roleUpdated;
    case "assignmentCreated":
      return labels.assignmentCreated;
    case "recoveryIssued":
      return labels.successRecovery;
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
          <h2>{labels.accounts}</h2>
        </div>
        <div className="identity-account-list">
          {accounts.map((account) => (
            <article className="identity-account-row" data-testid="identity-account-row" key={account.id}>
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
                <RecoveryForm labels={labels} locale={locale} userAccountId={account.id} />
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
