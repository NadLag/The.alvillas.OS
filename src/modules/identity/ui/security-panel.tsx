"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useState, useTransition } from "react";
import {
  beginPasskeyRegistrationAction,
  confirmTotpEnrollmentAction,
  finishPasskeyRegistrationAction,
  startTotpEnrollmentAction,
  type IdentityFormState
} from "@/modules/identity/application/identity-actions";

type SecurityPanelProps = {
  labels: {
    title: string;
    subtitle: string;
    startTotp: string;
    confirmTotp: string;
    totpCode: string;
    totpSecret: string;
    recoveryCodes: string;
    registerPasskey: string;
    passkeyReady: string;
    validation: string;
    generic: string;
  };
};

export function SecurityPanel({ labels }: SecurityPanelProps) {
  const [state, setState] = useState<IdentityFormState>({ status: "idle" });
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  function startTotp() {
    startTransition(() => {
      void startTotpEnrollmentAction().then(setState);
    });
  }

  function confirmTotp() {
    if (!state.totpCredentialId) {
      setState({ status: "error", messageKey: "validation" });
      return;
    }

    startTransition(() => {
      void confirmTotpEnrollmentAction(state.totpCredentialId ?? "", totpCode).then(setState);
    });
  }

  function registerPasskey() {
    startTransition(() => {
      void beginPasskeyRegistrationAction()
        .then(async ({ challengeId, options }) => {
          const response = await startRegistration(options);

          return finishPasskeyRegistrationAction(challengeId, response);
        })
        .then(setState)
        .catch(() => setState({ status: "error", messageKey: "generic" }));
    });
  }

  const message =
    state.messageKey === "passkeyRegistered"
      ? labels.passkeyReady
      : state.messageKey === "validation"
        ? labels.validation
        : state.messageKey === "generic"
          ? labels.generic
          : null;

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
