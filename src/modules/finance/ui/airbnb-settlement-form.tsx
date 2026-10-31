"use client";

import { useActionState, useMemo, useCallback } from "react";
import { z } from "zod";
import { useServerActionValidation, useZodForm } from "@/design-system/forms";
import { formatCurrencyAmount } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import type { AirbnbSettlementFormState } from "@/modules/finance/application/airbnb-settlement-actions";
import { importAirbnbSettlementAction } from "@/modules/finance/application/airbnb-settlement-actions";

import { PaymentAccountPicker } from "./payment-account-picker";

type FormLabels = {
  validation: string;
  unauthorized: string;
  forbidden: string;
  notFound: string;
  config: string;
  conflict: string;
  generic: string;
};

type SettlementLabels = FormLabels & {
  title: string;
  subtitle: string;
  csv: string;
  csvHint: string;
  account: string;
  noAccounts: string;
  import: string;
  importing: string;
  variances: string;
  noVariances: string;
  expected: string;
  actual: string;
  variance: string;
  reason: string;
  action: string;
};

type RevenueAccountOption = {
  id: string;
  name: string;
  code: string;
};

export type AirbnbSettlementVarianceView = {
  id: string;
  settlementId: string;
  reservationReference: string | null;
  propertyName: string | null;
  sourceReservationId: string | null;
  sourceTransactionId: string | null;
  expectedAmount: {
    amount: string;
    currency: string;
  };
  actualAmount: {
    amount: string;
    currency: string;
  };
  varianceAmount: {
    amount: string;
    currency: string;
  };
  reason: string;
  action: string;
};

const initialAirbnbSettlementFormState: AirbnbSettlementFormState = { status: "idle" };

function messageForState(state: AirbnbSettlementFormState, labels: FormLabels): string | null {
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
      return labels.conflict;
    case "generic":
      return labels.generic;
    default:
      return null;
  }
}

function fieldError(state: AirbnbSettlementFormState, field: string): string | null {
  return state.fieldErrors?.[field]?.[0] ?? null;
}

function moneyText(locale: string, value: { amount: string; currency: string }): string {
  return formatCurrencyAmount(safeLocale(locale), value.amount, value.currency);
}

function moneyAmount(value: { amount: string; currency: string }): string {
  return value.amount;
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

export function AirbnbSettlementPanel({
  locale,
  idempotencyKey,
  accounts,
  variances,
  labels
}: {
  locale: string;
  idempotencyKey: string;
  accounts: RevenueAccountOption[];
  variances: AirbnbSettlementVarianceView[];
  labels: SettlementLabels;
}) {
  const [state, formAction, pending] = useActionState(
    importAirbnbSettlementAction.bind(null, locale),
    initialAirbnbSettlementFormState
  );
  const schema = useMemo(
    () =>
      z.object({
        csv: z.string().trim().min(1, labels.validation),
        receivedAccountId: z.string().trim().min(1, labels.validation)
      }),
    [labels.validation]
  );
  const form = useZodForm(schema, {
    defaultValues: {
      receivedAccountId:accounts[0]?.id??"",
      csv: ""
    }
  });
  const changeAccount=useCallback((value:string)=>form.setValue("receivedAccountId",value,{shouldDirty:true,shouldValidate:true}),[form]);
  const validateSubmit = useServerActionValidation(form, formAction);
  const message = messageForState(state, labels);
  const hasAccounts = accounts.length > 0;
  const appLocale = safeLocale(locale);

  return (
    <section className="settlement-panel" data-testid="airbnb-settlement-panel">
      <div className="section-heading">
        <div>
          <p className="panel-label">{labels.title}</p>
          <p className="field-hint">{labels.subtitle}</p>
        </div>
        <span data-testid="airbnb-settlement-variance-count">{variances.length}</span>
      </div>

      <form
        className="settlement-import-form"
        action={formAction}
        data-testid="airbnb-settlement-form"
        onSubmit={validateSubmit}
      >
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
        <div className="field"><PaymentAccountPicker source={{kind:"revenue"}} testId="airbnb-settlement-account" name="receivedAccountId" label={labels.account} initialValue={accounts[0]?.id??""} onValueChange={changeAccount} inputRef={form.register("receivedAccountId").ref} disabled={pending}/>
          <ErrorText testId="airbnb-settlement-account-error">{firstClientError(form.formState.errors.receivedAccountId) ?? fieldError(state, "receivedAccountId")}</ErrorText></div>
        <label className="field settlement-csv-field">
          <span>{labels.csv}</span>
          <textarea
            data-testid="airbnb-settlement-csv"
            placeholder={labels.csvHint}
            required
            rows={6}
            {...form.register("csv")}
          />
          <ErrorText testId="airbnb-settlement-csv-error">
            {firstClientError(form.formState.errors.csv) ?? fieldError(state, "csv")}
          </ErrorText>
        </label>
        {message ? (
          <p className="form-error" data-testid="airbnb-settlement-form-error" role="alert">
            {message}
          </p>
        ) : null}
        <button
          className="primary-button"
          data-testid="airbnb-settlement-submit"
          disabled={pending || !hasAccounts}
          type="submit"
        >
          {pending ? labels.importing : labels.import}
        </button>
      </form>

      <div className="settlement-variance-list" data-testid="airbnb-settlement-variance-list">
        <p className="panel-label">{labels.variances}</p>
        {variances.length === 0 ? (
          <p className="empty-state" data-testid="airbnb-settlement-empty">
            {labels.noVariances}
          </p>
        ) : (
          variances.map((variance) => (
            <article
              className="settlement-variance-row"
              data-actual={moneyAmount(variance.actualAmount)}
              data-expected={moneyAmount(variance.expectedAmount)}
              data-testid="airbnb-settlement-variance"
              data-variance={moneyAmount(variance.varianceAmount)}
              key={variance.id}
            >
              <div>
                <strong>{variance.reservationReference ?? variance.sourceReservationId}</strong>
                <small>{variance.propertyName ?? variance.sourceTransactionId}</small>
              </div>
              <div className="settlement-chain" aria-label={labels.variances}>
                <span>
                  <small>{labels.expected}</small>
                  <strong data-testid="airbnb-settlement-expected">
                    {moneyText(appLocale, variance.expectedAmount)}
                  </strong>
                </span>
                <span>
                  <small>{labels.actual}</small>
                  <strong data-testid="airbnb-settlement-actual">
                    {moneyText(appLocale, variance.actualAmount)}
                  </strong>
                </span>
                <span>
                  <small>{labels.variance}</small>
                  <strong data-testid="airbnb-settlement-variance-amount">
                    {moneyText(appLocale, variance.varianceAmount)}
                  </strong>
                </span>
                <span>
                  <small>{labels.reason}</small>
                  <strong>{variance.reason}</strong>
                </span>
                <span>
                  <small>{labels.action}</small>
                  <strong>{variance.action}</strong>
                </span>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
