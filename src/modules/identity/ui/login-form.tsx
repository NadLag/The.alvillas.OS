"use client";

import { useActionState } from "react";
import type { LoginFormState } from "@/modules/identity/application/session-actions";
import { loginAction } from "@/modules/identity/application/session-actions";

type LoginFormProps = {
  locale: string;
  labels: {
    email: string;
    phone: string;
    password: string;
    pin: string;
    authMethod: string;
    mfaCode: string;
    recoveryCode: string;
    submit: string;
    invalid: string;
    rateLimited: string;
    generic: string;
  };
};

const initialState: LoginFormState = { status: "idle" };

export function LoginForm({ locale, labels }: LoginFormProps) {
  const [state, formAction, pending] = useActionState(
    loginAction.bind(null, locale),
    initialState
  );
  const message =
    state.messageKey === "rateLimited"
      ? labels.rateLimited
      : state.messageKey === "invalid"
        ? labels.invalid
        : state.messageKey === "generic"
          ? labels.generic
          : null;

  return (
    <form className="auth-form" action={formAction}>
      <label className="field">
        <span>{labels.email}</span>
        <input
          autoComplete="email"
          data-testid="login-email"
          name="email"
          type="email"
        />
      </label>
      <label className="field">
        <span>{labels.phone}</span>
        <input
          autoComplete="tel"
          data-testid="login-phone"
          name="phone"
          type="tel"
        />
      </label>
      <label className="field">
        <span>{labels.password}</span>
        <input
          autoComplete="current-password"
          data-testid="login-password"
          name="password"
          type="password"
        />
      </label>
      <label className="field">
        <span>{labels.pin}</span>
        <input
          autoComplete="one-time-code"
          data-testid="login-pin"
          inputMode="numeric"
          name="pin"
          pattern="[0-9]*"
          type="password"
        />
      </label>
      <label className="field">
        <span>{labels.mfaCode}</span>
        <input
          autoComplete="one-time-code"
          data-testid="login-mfa-code"
          inputMode="numeric"
          name="mfaCode"
          pattern="[0-9]*"
          type="text"
        />
      </label>
      <label className="field">
        <span>{labels.recoveryCode}</span>
        <input
          autoComplete="one-time-code"
          data-testid="login-recovery-code"
          name="recoveryCode"
          type="text"
        />
      </label>
      <div className="segmented-control" aria-label={labels.authMethod}>
        <label>
          <input name="method" type="radio" value="password" defaultChecked />
          <span>{labels.password}</span>
        </label>
        <label>
          <input name="method" type="radio" value="pin" />
          <span>{labels.pin}</span>
        </label>
      </div>
      {message ? (
        <p className="form-error" data-testid="login-error" role="alert">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="login-submit" disabled={pending} type="submit">
        {labels.submit}
      </button>
    </form>
  );
}
