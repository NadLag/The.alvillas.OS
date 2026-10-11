"use client";

import { useActionState } from "react";
import type { LoginFormState } from "@/modules/identity/application/session-actions";
import { loginAction } from "@/modules/identity/application/session-actions";

type LoginFormProps = {
  locale: string;
  labels: {
    email: string;
    password: string;
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
