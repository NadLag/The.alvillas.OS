"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  beginPasskeyRegistrationAction,
  confirmTotpEnrollmentAction,
  finishPasskeyRegistrationAction,
  startTotpEnrollmentAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";

type SecurityPanelProps = {
  signInHref: string;
  labels: {
    title: string;
    subtitle: string;
    startTotp: string;
    confirmTotp: string;
    totpCode: string;
    totpSecret: string;
    totpInvalid: string;
    recoveryCodes: string;
    registerPasskey: string;
    passkeyReady: string;
    validation: string;
    generic: string;
    unauthorized: string;
    forbidden: string;
    signInAgain: string;
  };
};

export function SecurityPanel({ labels, signInHref }: SecurityPanelProps) {
  const [state, setState] = useState<IdentityFormState>({ status: "idle" });
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  function startTotp() {
    startTransition(async () => {
      setState(await startTotpEnrollmentAction());
    });
  }

  function confirmTotp() {
    if (!state.totpCredentialId) {
      setState({ status: "error", messageKey: "validation" });
      return;
    }

    startTransition(async () => {
      const result = await confirmTotpEnrollmentAction(state.totpCredentialId ?? "", totpCode);
      setState((current) => result.status === "error" && result.messageKey === "conflict"
        ? { ...current, status: result.status, messageKey: "totpInvalid" }
        : result);
    });
  }

  function registerPasskey() {
    startTransition(async () => {
      try {
        const { challengeId, options } = await beginPasskeyRegistrationAction();
        const response = await startRegistration({ optionsJSON: options });
        setState(await finishPasskeyRegistrationAction(challengeId, response));
      } catch {
        setState({ status: "error", messageKey: "generic" });
      }
    });
  }

  const statusMessages: Partial<Record<NonNullable<IdentityFormState["messageKey"]>, string>> = {
    passkeyRegistered: labels.passkeyReady,
    totpInvalid: labels.totpInvalid,
    validation: labels.validation,
    unauthorized: labels.unauthorized,
    forbidden: labels.forbidden,
    generic: labels.generic
  };
  const message = state.messageKey ? statusMessages[state.messageKey] ?? null : null;

  return (
    <section className="detail-panel identity-security-panel">
      <div>
        <p className="panel-label">{labels.title}</p>
        <p>{labels.subtitle}</p>
      </div>

      <div className="identity-security-actions">
        <button className="secondary-button" data-testid="start-totp-button" disabled={isPending} onClick={startTotp} type="button">
          {labels.startTotp}
        </button>
        <button className="secondary-button" data-testid="register-passkey-button" disabled={isPending} onClick={registerPasskey} type="button">
          {labels.registerPasskey}
        </button>
      </div>

      {state.totpSecret ? (
        <div className="identity-mfa-setup">
          <code className="copy-code" data-testid="totp-secret">
            {labels.totpSecret}: {state.totpSecret}
          </code>
          <label className="field">
            <span>{labels.totpCode}</span>
            <input
              data-testid="totp-code"
              inputMode="numeric"
              onChange={(event) => setTotpCode(event.target.value)}
              value={totpCode}
            />
          </label>
          <button className="primary-button" data-testid="confirm-totp-button" disabled={isPending} onClick={confirmTotp} type="button">
            {labels.confirmTotp}
          </button>
        </div>
      ) : null}

      {state.recoveryCodes ? (
        <div className="identity-recovery-codes">
          <strong>{labels.recoveryCodes}</strong>
          {state.recoveryCodes.map((code) => (
            <code className="copy-code" data-testid="mfa-recovery-code" key={code}>
              {code}
            </code>
          ))}
          <Link className="secondary-button" href={signInHref}>{labels.signInAgain}</Link>
        </div>
      ) : null}

      {message ? (
        <p className={state.status === "success" ? "form-status" : "form-error"} role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
