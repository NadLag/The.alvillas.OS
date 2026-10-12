"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createInvitationAction,
  issueRecoveryCodeAction,
  reactivateAccountAction,
  suspendAccountAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";
import type { IdentityAccountSummary, InvitationSummary } from "@/modules/identity/infrastructure/identity-repository";

type IdentityAdminProps = {
  locale: string;
  accounts: IdentityAccountSummary[];
  invitations: InvitationSummary[];
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

export function IdentityAdmin({ locale, accounts, invitations, labels }: IdentityAdminProps) {
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
                <option value="admin">{labels.admin}</option>
                <option value="finance">{labels.finance}</option>
                <option value="field_staff">{labels.fieldStaff}</option>
                <option value="owner">{labels.owner}</option>
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
                <strong>{account.roles.join(", ")}</strong>
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
