"use client";

import { useActionState, useMemo, useCallback } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import type { ReservationRevenueFormState } from "@/modules/finance/application/reservation-revenue-actions";
import { recordReservationRevenueAction } from "@/modules/finance/application/reservation-revenue-actions";

import { PaymentAccountPicker } from "./payment-account-picker";

type FormLabels = {
  saving: string;
  validation: string;
  unauthorized: string;
  forbidden: string;
  notFound: string;
  config: string;
  conflict?: string;
  generic: string;
};

type ReservationRevenueLabels = FormLabels & {
  amount: string;
  currency: string;
  account: string;
  noAccounts: string;
  recordRevenue: string;
  recordingRevenue: string;
  revenuePosted: string;
};

type RevenueAccountOption = {
  id: string;
  name: string;
  code: string;
};

const initialReservationRevenueFormState: ReservationRevenueFormState = { status: "idle" };

function messageForState(state: ReservationRevenueFormState, labels: FormLabels): string | null {
  switch (state.messageKey) {
    case "validation":
      return labels.validation;
    case "unauthorized":
      return labels.unauthorized;
    case "forbidden":
      return labels.forbidden;
    case "notFound":
      return labels.notFound;
    case "config":
      return labels.config;
    case "conflict":
      return labels.conflict ?? labels.generic;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

function fieldError(state: ReservationRevenueFormState, field: string): string | null {
  return state.fieldErrors?.[field]?.[0] ?? null;
}

function ErrorText({ children, testId }: { children: string | null; testId: string }) {
  if (!children) {
    return null;
  }

  return (
    <p className="field-error" data-testid={testId}>
      {children}
    </p>
  );
}

function firstClientError(error: unknown): string | null {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : null;
}

export function ReservationRevenueForm({
  locale,
  reservationId,
  idempotencyKey,
  accounts,
  posted,
  labels
}: {
  locale: string;
  reservationId: string;
  idempotencyKey: string;
  accounts: RevenueAccountOption[];
  posted: boolean;
  labels: ReservationRevenueLabels;
}) {
  const [state, formAction, pending] = useActionState(
    recordReservationRevenueAction.bind(null, locale),
    initialReservationRevenueFormState
  );
  const schema = useMemo(
    () =>
      z.object({
        amount: z.string().trim().min(1, labels.validation),
        currency: z.string().trim().length(3, labels.validation),
        receivedAccountId: z.string().trim().min(1, labels.validation)
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      receivedAccountId:accounts[0]?.id??"",
      amount: "",
      currency: "MAD"
    }
  });
  const changeAccount=useCallback((value:string)=>form.setValue("receivedAccountId",value,{shouldDirty:true,shouldValidate:true}),[form]);
  const validateSubmit = useServerActionValidation(form, formAction);
  const message = messageForState(state, labels);
  const hasAccounts = accounts.length > 0;

  if (posted) {
    return (
      <p className="field-hint" data-testid="reservation-revenue-posted">
        {labels.revenuePosted}
      </p>
    );
  }

  return (
    <form
      className="reservation-revenue-form"
      action={formAction}
      data-testid="reservation-revenue-form"
      onSubmit={validateSubmit}
    >
      <input name="reservationId" type="hidden" value={reservationId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <label className="field">
        <span>{labels.amount}</span>
        <input data-testid="reservation-revenue-amount" inputMode="decimal" required {...form.register("amount")} />
        <ErrorText testId="reservation-revenue-amount-error">
          {firstClientError(form.formState.errors.amount) ?? fieldError(state, "amount")}
        </ErrorText>
      </label>
      <label className="field">
        <span>{labels.currency}</span>
        <input data-testid="reservation-revenue-currency" maxLength={3} required {...form.register("currency")} />
        <ErrorText testId="reservation-revenue-currency-error">
          {firstClientError(form.formState.errors.currency) ?? fieldError(state, "currency")}
        </ErrorText>
      </label>
      <div className="field"><PaymentAccountPicker source={{kind:"revenue"}} testId="reservation-revenue-account" name="receivedAccountId" label={labels.account} initialValue={accounts[0]?.id??""} onValueChange={changeAccount} inputRef={form.register("receivedAccountId").ref} disabled={pending}/>
        <ErrorText testId="reservation-revenue-account-error">{firstClientError(form.formState.errors.receivedAccountId) ?? fieldError(state, "receivedAccountId")}</ErrorText></div>
      {message ? (
        <p className="form-error" data-testid="reservation-revenue-form-error" role="alert">
          {message}
        </p>
      ) : null}
      <button
        className="primary-button"
        data-testid="reservation-revenue-submit"
        disabled={pending || !hasAccounts}
        type="submit"
      >
        {pending ? labels.recordingRevenue : labels.recordRevenue}
      </button>
    </form>
  );
}
