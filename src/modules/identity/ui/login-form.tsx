"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { LoginFormState } from "@/modules/identity/application/session-actions";
import { beginPasskeyLoginAction, finishPasskeyLoginAction, loginAction } from "@/modules/identity/application/session-actions";
import { PinKeypad } from "@/design-system/pin-keypad";
import { normalizePinInput } from "../domain/pin-input";

type LoginMethod = "password" | "pin";

type LoginFormProps = {
  locale: string;
  surface?: "field";
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
    passkey: string;
    pinKeypad: string;
    pinClear: string;
    pinDelete: string;
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

export function LoginForm({ locale, labels, surface }: LoginFormProps) {
  const [method, setMethod] = useState<LoginMethod>(surface === "field" ? "pin" : "password");
  const [pin, setPin] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [passkeyState, setPasskeyState] = useState<LoginFormState | null>(null);
  const [email, setEmail] = useState("");
  const [passkeyPending, startPasskeyTransition] = useTransition();
  const [state, formAction, pending] = useActionState(
    async (previous: LoginFormState, formData: FormData) => {
      const result = await loginAction(locale, previous, formData);
      if (formData.get("method") === "pin" && result.status === "error") setPin("");
      setPasskeyState(null);
      return result;
    },
    initialState
  );
  const activeState = state.status === "mfaRequired" ? state : passkeyState ?? state;
  const message = loginMessage(activeState, labels);
  const mfaRequired =
    activeState.status === "mfaRequired" && Boolean(activeState.email && activeState.mfaChallenge);
  const busy = pending || passkeyPending;
  function passkeyLogin() {
    startPasskeyTransition(async () => {
      try {
        const { challengeId, options } = await beginPasskeyLoginAction(email);
        const response = await startAuthentication({ optionsJSON: options });
        setPasskeyState(await finishPasskeyLoginAction(locale, email, challengeId, response, surface));
      } catch {
        setPasskeyState({ status: "error", messageKey: "generic" });
      }
    });
  }
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
      onReset={(event) => event.preventDefault()}
    >
      {surface ? <input name="surface" type="hidden" value={surface} /> : null}
      {mfaRequired ? (
        <div className="auth-mfa-step" data-testid="login-mfa-step">
          <input name="method" type="hidden" value="mfa" />
          <input name="email" type="hidden" value={activeState.email} />
          <input name="mfaChallenge" type="hidden" value={activeState.mfaChallenge} />
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
                  disabled={busy}
                  name="method"
                  onChange={() => { setMethod("password"); setPin(""); }}
                  type="radio"
                  value="password"
                />
                <span>{labels.emailPassword}</span>
              </label>
              <label>
                <input
                  checked={method === "pin"}
                  disabled={busy}
                  name="method"
                  onChange={() => { setMethod("pin"); setPin(""); }}
                  type="radio"
                  value="pin"
                />
                <span>{labels.phonePin}</span>
              </label>
            </div>
            <p className="field-hint">{labels.fieldWorker}</p>
          </fieldset>
          {method === "password" ? (
            <div className="auth-field-group" key="password">
              <label className="field">
                <span>{labels.email}</span>
                <input
                  autoComplete="email"
                  autoFocus
                  data-testid="login-email"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  value={email}
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
            <div className="auth-field-group" key="pin">
              <label className="field">
                <span>{labels.phone}</span>
                <input
                  autoComplete="tel"
                  autoFocus
                  data-testid="login-phone"
                  disabled={busy}
                  name="phone"
                  required
                  type="tel"
                />
              </label>
              <label className="field">
                <span>{labels.pin}</span>
                <input
                  autoComplete="current-password"
                  data-testid="login-pin"
                  disabled={busy}
                  inputMode="numeric"
                  name="pin"
                  pattern="[0-9]*"
                  required
                  type="password"
                  value={pin}
                  onChange={event => setPin(normalizePinInput(event.target.value))}
                />
              </label>
              <PinKeypad disabled={busy} onDigit={digit => setPin(value => value + digit)} onDelete={() => setPin(value => value.slice(0, -1))}
                onClear={() => setPin("")} labels={{ keypad: labels.pinKeypad, clear: labels.pinClear, delete: labels.pinDelete }} />
            </div>
          )}
        </>
      )}
      {message ? (
        <p className="form-error" data-testid="login-error" id="login-error" role="alert">
          {message}
        </p>
      ) : null}
      <button className="primary-button" data-testid="login-submit" disabled={busy} type="submit">
        {submitLabel}
      </button>
      {!mfaRequired && method === "password" ? (
        <button className="secondary-button" data-testid="login-passkey" disabled={busy || !email} onClick={passkeyLogin} type="button">
          {busy ? labels.submitting : labels.passkey}
        </button>
      ) : null}
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
