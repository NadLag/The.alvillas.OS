"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { expenseDraftSchema } from "../domain/expense";
import { createExpenseDraftAction, submitExpenseAction } from "../application/expense-actions";
import type { getExpenseEditor, getExpense } from "../application/expense-service";

type ErrorCode = "forbidden" | "conflict" | "configuration" | "validation" | "error";
export function ExpenseDraftForm({ editor }: { editor: Awaited<ReturnType<typeof getExpenseEditor>> }) {
  const t = useTranslations("Expenses"), locale = useLocale(), router = useRouter(), key = useRef<string | null>(null);
  const [ready, setReady] = useState(false), [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => { queueMicrotask(() => { key.current = crypto.randomUUID(); setReady(true); }); }, []);
  return <form className="resource-form" data-testid="expense-draft-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (!key.current || pending) return;
    const form = new FormData(event.currentTarget); setError(null);
    const reservation = form.get("reservationId"), amount = form.get("amount");
    const input = expenseDraftSchema.safeParse({ propertyId: editor.property.id, reservationId: typeof reservation === "string" ? reservation.trim() || undefined : reservation,
      amount: typeof amount === "string" ? amount.replace(",", ".") : amount, currency: form.get("currency"), category: form.get("category"), purpose: form.get("purpose"),
      occurredOn: form.get("occurredOn"), fundingAccountId: form.get("fundingAccountId"), emergency: form.get("emergency") === "on", idempotencyKey: key.current, reason: form.get("reason") });
    if (!input.success) { setError("validation"); return; }
    startTransition(async () => {
      try { const result = await createExpenseDraftAction(input.data); if (!result.ok) setError(result.code); else router.push(`/${locale}/app/expenses/${result.data.id}`); }
      catch { setError("error"); }
    });
  }}>
    {error ? <p role="alert" data-testid="expense-error">{t(error)}</p> : null}
    {!editor.accounts.length ? <p role="status">{t("noAccounts")}</p> : null}
    <fieldset className="resource-form" disabled={!ready || pending || !editor.accounts.length}><legend>{t("new")}</legend>
      <div className="form-grid two">
        <label className="field"><span>{t("amount")}</span><input name="amount" data-testid="expense-amount" type="text" inputMode="decimal" dir="ltr" maxLength={19} required /></label>
        <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="expense-currency" defaultValue={editor.baseCurrency} required>{editor.currencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></label>
        <label className="field"><span>{t("category")}</span><input name="category" data-testid="expense-category" maxLength={120} pattern={"[a-z][a-z0-9_.\\-]*"} required /></label>
        <label className="field"><span>{t("occurredOn")}</span><input name="occurredOn" data-testid="expense-occurred-on" type="date" defaultValue={editor.today} required /></label>
      </div>
      <label className="field"><span>{t("purpose")}</span><textarea name="purpose" data-testid="expense-purpose" minLength={3} maxLength={1000} required /></label>
      <label className="field"><span>{t("fundingAccount")}</span><select name="fundingAccountId" data-testid="expense-funding-account" required>{editor.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label className="field"><span>{t("reservation")}</span><select name="reservationId" data-testid="expense-reservation" defaultValue=""><option value="">{t("noReservation")}</option>{editor.reservations.map(reservation => <option key={reservation.id} value={reservation.id}>{reservation.reference}</option>)}</select></label>
      <label className="checkbox-field"><input name="emergency" data-testid="expense-emergency" type="checkbox" /><span>{t("emergency")}</span></label>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="expense-reason" minLength={6} maxLength={500} required /></label>
      <div className="form-actions"><button className="primary-button" data-testid="expense-create" type="submit">{t(pending ? "saving" : "saveDraft")}</button></div>
    </fieldset>
  </form>;
}
export function ExpenseSubmissionForm({ expense }: { expense: Awaited<ReturnType<typeof getExpense>> }) {
  const t = useTranslations("Expenses"), router = useRouter(), [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null);
  return <form className="resource-form" data-testid="expense-submit-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (pending) return; const form = new FormData(event.currentTarget); setError(null);
    startTransition(async () => {
      try { const result = await submitExpenseAction({ id: expense.id, expectedVersion: expense.version, reason: form.get("reason") }); if (!result.ok) setError(result.code); else router.refresh(); }
      catch { setError("error"); }
    });
  }}>{error ? <p role="alert" data-testid="expense-error">{t(error)}</p> : null}
    <fieldset className="resource-form" disabled={pending}><legend>{t("submit")}</legend><p>{t("submitGuidance")}</p>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="expense-submit-reason" minLength={6} maxLength={500} required /></label>
      <div className="form-actions"><button className="primary-button" data-testid="expense-submit" type="submit">{t(pending ? "saving" : "submit")}</button></div>
    </fieldset>
  </form>;
}
