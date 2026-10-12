"use client";

import { useActionState } from "react";
import {
  activateInvitationAction,
  recoverPasswordAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";

type ActivationFormProps = {
  locale: string;
  code: string;
  labels: {
    phone: string;
    pin: string;
    password: string;
    activate: string;
    validation: string;
    conflict: string;
    generic: string;
  };
};

type RecoveryFormProps = {
  locale: string;
  labels: {
    email: string;
    recoveryCode: string;
    newPassword: string;
    recover: string;
    validation: string;
    conflict: string;
    generic: string;
  };
};

const initialState: IdentityFormState = { status: "idle" };

function message(
  state: IdentityFormState,
  labels: { validation: string; conflict: string; generic: string }
): string | null {
  switch (state.messageKey) {
    case "validation":
      return labels.validation;
    case "conflict":
      return labels.conflict;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

export function ActivationForm({ locale, code, labels }: ActivationFormProps) {
  const [state, formAction, pending] = useActionState(
    activateInvitationAction.bind(null, locale, code),
    initialState
  );
  const formMessage = message(state, labels);

  return (
    <form className="auth-form" action={formAction}>
      <label className="field">
        <span>{labels.phone}</span>
        <input autoComplete="tel" data-testid="activation-phone" name="phone" required type="tel" />
      </label>
      <label className="field">
        <span>{labels.pin}</span>
        <input data-testid="activation-pin" inputMode="numeric" name="pin" pattern="[0-9]{6}" required type="password" />
      </label>
      <label className="field">
        <span>{labels.password}</span>
        <input autoComplete="new-password" data-testid="activation-password" name="password" type="password" />
      </label>
      {formMessage ? (
        <p className="form-error" data-testid="identity-form-error" role="alert">
          {formMessage}
        </p>
      ) : null}
      <button className="primary-button" data-testid="activation-submit" disabled={pending} type="submit">
        {labels.activate}
      </button>
    </form>
  );
}

export function PasswordRecoveryForm({ locale, labels }: RecoveryFormProps) {
  const [state, formAction, pending] = useActionState(
    recoverPasswordAction.bind(null, locale),
    initialState
  );
  const formMessage = message(state, labels);

  return (
    <form className="auth-form" action={formAction}>
      <label className="field">
        <span>{labels.email}</span>
        <input autoComplete="email" data-testid="recovery-email" name="email" required type="email" />
      </label>
      <label className="field">
        <span>{labels.recoveryCode}</span>
        <input autoComplete="one-time-code" data-testid="recovery-code-input" name="recoveryCode" required />
      </label>
      <label className="field">
        <span>{labels.newPassword}</span>
        <input autoComplete="new-password" data-testid="recovery-password" name="newPassword" required type="password" />
      </label>
      {formMessage ? (
        <p className="form-error" data-testid="identity-form-error" role="alert">
          {formMessage}
        </p>
      ) : null}
      <button className="primary-button" data-testid="recovery-submit" disabled={pending} type="submit">
        {labels.recover}
      </button>
    </form>
  );
}
