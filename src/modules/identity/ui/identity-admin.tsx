"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createInvitationAction,
  issueRecoveryCodeAction,
  reactivateAccountAction,
  suspendAccountAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";
import type { AccountPermissionSimulation } from "@/modules/identity/application/identity-service";
import type { IdentityAccountSummary, InvitationSummary } from "@/modules/identity/infrastructure/identity-repository";
import type { RoleCatalogSummary } from "@/modules/identity/infrastructure/identity-repository";

type IdentityAdminProps = {
  locale: string;
  accounts: IdentityAccountSummary[];
  invitations: InvitationSummary[];
  roles: RoleCatalogSummary[];
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
    organization: string;
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
  owner_representative: "ownerRepresentative"
};

function roleLabel(roleKey: string, labels: IdentityAdminProps["labels"]): string {
  const key = roleLabelKey[roleKey];

  return key ? labels[key] : roleKey;
}

export function IdentityAdmin({
  locale,
  accounts,
  invitations,
  roles,
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
                    {roleLabel(role.key, labels)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{labels.scope}</span>
              <select name="scopeType">
                <option value="organization">{labels.organization}</option>
              </select>
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
        <div className="identity-account-list">
          {roles.map((role) => (
            <article className="identity-account-row role-catalog-row" data-testid="role-catalog-row" key={role.id}>
              <span>
                <strong>{roleLabel(role.key, labels)}</strong>
                <small>{role.description ?? role.key}</small>
              </span>
              <span>
                <small>{labels.permissionCount}</small>
                <strong>{role.permissionCount}</strong>
              </span>
              <span>
                <small>{labels.assignmentCount}</small>
                <strong>{role.assignmentCount}</strong>
              </span>
            </article>
          ))}
        </div>
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
                  <strong>{invitation.expiresAt.toLocaleString()}</strong>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
