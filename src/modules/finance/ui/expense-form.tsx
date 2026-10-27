"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { expenseDraftSchema } from "../domain/expense";
import { createExpenseDraftAction,updateExpenseDraftAction, submitExpenseAction,postExpenseAction,voidExpenseAction } from "../application/expense-actions";
import type { getExpenseEditor,getExpenseDraftEditor, getExpense } from "../application/expense-service";

type ErrorCode = "forbidden" | "conflict" | "configuration" | "validation" | "periodClosed" | "error";
export function ExpenseDraftForm({ editor,draft,fundingAccountId }: { editor: Awaited<ReturnType<typeof getExpenseEditor>>;draft?:Awaited<ReturnType<typeof getExpenseDraftEditor>>["draft"];fundingAccountId?:string }) {
  const t = useTranslations("Expenses"), locale = useLocale(), router = useRouter(), key = useRef<string | null>(null);
  const correction=Boolean(draft?.correctsExpenseId);
  const [ready, setReady] = useState(false), [pending, startTransition] = useTransition(), [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => { queueMicrotask(() => { key.current = draft?.idempotencyKey??crypto.randomUUID(); setReady(true); }); }, [draft?.idempotencyKey]);
  return <form className="resource-form" data-testid="expense-draft-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault(); if (!key.current || pending) return;
    const form = new FormData(event.currentTarget); setError(null);
    const reservation = form.get("reservationId"), amount = form.get("amount");
    const input = expenseDraftSchema.safeParse({ propertyId: editor.property.id, reservationId: typeof reservation === "string" ? reservation.trim() || undefined : reservation,
      amount: typeof amount === "string" ? amount.replace(",", ".") : amount, currency: form.get("currency"), category: form.get("category"), purpose: form.get("purpose"),
      occurredOn: form.get("occurredOn"), fundingAccountId: form.get("fundingAccountId"), emergency: form.get("emergency") === "on", idempotencyKey: key.current, reason: form.get("reason") });
    if (!input.success) { setError("validation"); return; }
    startTransition(async () => {
      try { const result = draft?await updateExpenseDraftAction({id:draft.id,expectedVersion:draft.version,draft:input.data}):await createExpenseDraftAction(input.data); if (!result.ok) setError(result.code); else router.push(`/${locale}/app/expenses/${result.data.id}`); }
      catch { setError("error"); }
    });
  }}>
    {correction?<><input type="hidden" name="currency" value={draft!.currency}/><input type="hidden" name="fundingAccountId" value={draft!.fundingAccountId}/>
      <input type="hidden" name="reservationId" value={draft!.reservationId??""}/><p>{t("correctionDraftGuidance")}</p></>:null}
    {error ? <p role="alert" data-testid="expense-error">{t(error)}</p> : null}
    {!editor.accounts.length ? <p role="status">{t("noAccounts")}</p> : null}
    <fieldset className="resource-form" disabled={!ready || pending || !editor.accounts.length}><legend>{t(draft?"editDraft":"new")}</legend>
      <div className="form-grid two">
        <label className="field"><span>{t("amount")}</span><input name="amount" data-testid="expense-amount" defaultValue={draft?.amount} type="text" inputMode="decimal" dir="ltr" maxLength={19} required /></label>
        <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="expense-currency" defaultValue={draft?.currency??editor.baseCurrency} disabled={correction} required>{editor.currencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></label>
        <label className="field"><span>{t("category")}</span><input name="category" data-testid="expense-category" defaultValue={draft?.category} readOnly={correction} maxLength={120} pattern={"[a-z][a-z0-9_.\\-]*"} required /></label>
        <label className="field"><span>{t("occurredOn")}</span><input name="occurredOn" data-testid="expense-occurred-on" type="date" defaultValue={draft?.occurredOn??editor.today} readOnly={correction} required /></label>
      </div>
      <label className="field"><span>{t("purpose")}</span><textarea name="purpose" data-testid="expense-purpose" defaultValue={draft?.purpose} readOnly={correction} minLength={3} maxLength={1000} required /></label>
      <label className="field"><span>{t("fundingAccount")}</span><select name="fundingAccountId" data-testid="expense-funding-account" defaultValue={draft?.fundingAccountId??fundingAccountId??""} disabled={correction} required>
        <option value="" disabled>{t("selectFunding")}</option>{draft&&!editor.accounts.some(account=>account.id===draft.fundingAccountId)?<option value={draft.fundingAccountId} disabled>{t("unavailableFunding")}</option>:null}
        {editor.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label className="field"><span>{t("reservation")}</span><select name="reservationId" data-testid="expense-reservation" defaultValue={draft?.reservationId??""} disabled={correction}><option value="">{t("noReservation")}</option>
        {draft?.reservationId&&!editor.reservations.some(row=>row.id===draft.reservationId)?<option value={draft.reservationId}>{t("retainedReservation")}</option>:null}
        {editor.reservations.map(reservation => <option key={reservation.id} value={reservation.id}>{reservation.reference}</option>)}</select></label>
      <label className="checkbox-field"><input name="emergency" data-testid="expense-emergency" defaultChecked={draft?.emergency} disabled={correction} type="checkbox" /><span>{t("emergency")}</span></label>
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

export function ExpensePostingForm({expense}:{expense:Awaited<ReturnType<typeof getExpense>>}){
  const t=useTranslations("Expenses"),router=useRouter(),[pending,startTransition]=useTransition(),[error,setError]=useState<ErrorCode|null>(null);
  const [ready,setReady]=useState(false);
  useEffect(()=>{queueMicrotask(()=>setReady(true));},[]);
  return <form className="resource-form" data-testid="expense-post-form" aria-busy={pending} onSubmit={event=>{
    event.preventDefault();if(pending)return;const form=new FormData(event.currentTarget);setError(null);
    startTransition(async()=>{
      try{const result=await postExpenseAction({id:expense.id,expectedVersion:expense.version,reason:form.get("reason"),...(form.get("currentPeriod")==="on"?{currentPeriod:true}:{})});
        if(!result.ok){setError(result.code);if(result.code==="periodClosed")router.refresh();}else router.refresh();}
      catch{setError("error");}
    });
  }}>
    {error?<p role="alert" data-testid="expense-error">{t(error)}</p>:null}
    <fieldset disabled={!ready||pending}><legend>{t("postTitle")}</legend><p>{t(expense.correctsExpenseId?"correctionPostingGuidance":"postGuidance")}</p>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="expense-post-reason" minLength={6} maxLength={500} required /></label>
      {expense.sourcePeriodClosed?<p data-testid="expense-source-period-closed">{t("sourcePeriodClosed")}</p>:null}
      {expense.canPostInCurrentPeriod?<label className="checkbox-field"><input type="checkbox" name="currentPeriod" data-testid="expense-current-period" required={!expense.canPostOriginalDate}/>
        <span className="field"><span>{t("currentPeriodChoice")}</span><small>{t("currentPeriodGuidance")}</small></span></label>:null}
      <div className="form-actions"><button type="submit" className="primary-button" data-testid="expense-post">{t(pending?"saving":"recordPayment")}</button></div>
    </fieldset>
  </form>;
}

export function ExpenseVoidForm({expense}:{expense:Awaited<ReturnType<typeof getExpense>>}){
  const t=useTranslations("Expenses"),router=useRouter(),[pending,startTransition]=useTransition(),[error,setError]=useState<ErrorCode|null>(null);
  return <form className="resource-form" data-testid="expense-void-form" aria-busy={pending} onSubmit={event=>{
    event.preventDefault();if(pending)return;const form=new FormData(event.currentTarget);setError(null);
    startTransition(async()=>{
      try{const result=await voidExpenseAction({id:expense.id,expectedVersion:expense.version,reason:form.get("reason")});if(!result.ok)setError(result.code);else router.refresh();}
      catch{setError("error");}
    });
  }}>
    {error?<p role="alert" data-testid="expense-error">{t(error)}</p>:null}
    <fieldset disabled={pending}><legend>{t("voidTitle")}</legend><p>{t("voidGuidance")}</p>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="expense-void-reason" minLength={6} maxLength={500} required /></label>
      <div className="form-actions"><button type="submit" className="secondary-button" data-testid="expense-void">{t(pending?"saving":"voidPayment")}</button></div>
    </fieldset>
  </form>;
}
