"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { LoginFormState } from "@/modules/identity/application/session-actions";
import { loginAction } from "@/modules/identity/application/session-actions";

type LoginMethod = "password" | "pin";

type LoginFormProps = {
  locale: string;
  labels: {
    email: string;
    phone: string;
    password: string;
    pin: string;
    authMethod: string;
    emailPassword: string;
    phonePin: string;
    fieldWorker: string;
    mfaTitle: string;
    mfaSubtitle: string;
    mfaCode: string;
    recoveryCode: string;
    useRecoveryCode: string;
    useAuthenticatorCode: string;
    recoverAccount: string;
    continue: string;
    verify: string;
    submit: string;
    submitting: string;
    invalid: string;
    mfaInvalid: string;
    rateLimited: string;
    generic: string;
  };
};

const initialState: LoginFormState = { status: "idle" };

function loginMessage(
  state: LoginFormState,
  labels: LoginFormProps["labels"]
): string | null {
  if (state.messageKey === "rateLimited") {
    return labels.rateLimited;
  }

  if (state.messageKey === "mfaInvalid") {
    return labels.mfaInvalid;
  }

  if (state.messageKey === "invalid") {
    return labels.invalid;
  }

  if (state.messageKey === "generic") {
    return labels.generic;
  }

  return null;
}

export function LoginForm({ locale, labels }: LoginFormProps) {
  const [method, setMethod] = useState<LoginMethod>("password");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [state, formAction, pending] = useActionState(
    loginAction.bind(null, locale),
    initialState
  );
  const message = loginMessage(state, labels);
  const mfaRequired =
    state.status === "mfaRequired" && Boolean(state.email && state.mfaChallenge);
  const submitLabel = pending
    ? labels.submitting
    : mfaRequired
      ? labels.verify
      : method === "password"
        ? labels.continue
        : labels.submit;

  return (
    <form
      aria-describedby={message ? "login-error" : undefined}
      className="auth-form"
      action={formAction}
    >
      {mfaRequired ? (
        <div className="auth-mfa-step" data-testid="login-mfa-step">
          <input name="method" type="hidden" value="mfa" />
          <input name="email" type="hidden" value={state.email} />
          <input name="mfaChallenge" type="hidden" value={state.mfaChallenge} />
          <div className="auth-summary">
            <p className="eyebrow">{labels.mfaTitle}</p>
            <p>{labels.mfaSubtitle}</p>
          </div>
          {recoveryMode ? (
            <label className="field">
              <span>{labels.recoveryCode}</span>
              <input
                autoComplete="one-time-code"
                autoFocus
                data-testid="login-recovery-code"
                name="recoveryCode"
                type="text"
              />
            </label>
          ) : (
            <label className="field">
              <span>{labels.mfaCode}</span>
              <input
                autoComplete="one-time-code"
                autoFocus
                data-testid="login-mfa-code"
                inputMode="numeric"
                name="mfaCode"
                pattern="[0-9]*"
                type="text"
              />
            </label>
          )}
          <button
            className="quiet-button"
            data-testid={recoveryMode ? "login-use-authenticator" : "login-use-recovery"}
            onClick={() => setRecoveryMode((current) => !current)}
            type="button"
          >
            {recoveryMode ? labels.useAuthenticatorCode : labels.useRecoveryCode}
          </button>
        </div>
      ) : (
        <>
          <fieldset className="auth-method-fieldset">
            <legend>{labels.authMethod}</legend>
            <div className="segmented-control">
              <label>
                <input
                  checked={method === "password"}
                  name="method"
                  onChange={() => setMethod("password")}
                  type="radio"
                  value="password"
                />
                <span>{labels.emailPassword}</span>
              </label>
              <label>
                <input
                  checked={method === "pin"}
                  name="method"
                  onChange={() => setMethod("pin")}
                  type="radio"
                  value="pin"
                />
                <span>{labels.phonePin}</span>
              </label>
            </div>
            <p className="field-hint">{labels.fieldWorker}</p>
          </fieldset>
          {method === "password" ? (
            <div className="auth-field-group">
              <label className="field">
                <span>{labels.email}</span>
                <input
                  autoComplete="email"
                  autoFocus
                  data-testid="login-email"
                  name="email"
                  required
                  type="email"
                />
              </label>
              <label className="field">
                <span>{labels.password}</span>
                <input
                  autoComplete="current-password"
                  data-testid="login-password"
                  name="password"
                  required
                  type="password"
                />
              </label>
            </div>
          ) : (
            <div className="auth-field-group">
              <label className="field">
                <span>{labels.phone}</span>
                <input
                  autoComplete="tel"
                  autoFocus
                  data-testid="login-phone"
                  name="phone"
                  required
                  type="tel"
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
                  required
                  type="password"
                />
              </label>
            </div>
          )}
        </>
      )}
      {message ? (
        <p className="form-error" data-testid="login-error" id="login-error" role="alert">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="login-submit" disabled={pending} type="submit">
        {submitLabel}
      </button>
      {!mfaRequired ? (
        <div className="auth-form-footer">
          <Link data-testid="login-recover-link" href={`/${locale}/recover`}>
            {labels.recoverAccount}
          </Link>
        </div>
      ) : null}
    </form>
  );
}
