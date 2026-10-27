"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createExpenseCorrectionDraftAction } from "../application/expense-actions";
import type { getExpense } from "../application/expense-service";

export function ExpenseCorrectionForm({ expense }: { expense: Awaited<ReturnType<typeof getExpense>> }) {
  const t = useTranslations("Expenses"), locale = useLocale(), router = useRouter(), key = useRef<string | null>(null);
  const [ready,setReady]=useState(false),[pending,startTransition]=useTransition();
  const [error,setError]=useState<"forbidden"|"conflict"|"configuration"|"validation"|"periodClosed"|"error"|null>(null);
  useEffect(()=>{queueMicrotask(()=>{key.current=crypto.randomUUID();setReady(true);});},[]);
  return <form className="resource-form" data-testid="expense-correction-form" aria-busy={pending} onSubmit={event=>{
    event.preventDefault();if(!key.current||pending)return;const form=new FormData(event.currentTarget),amount=form.get("amount");setError(null);
    if(typeof amount!=="string"){setError("validation");return;}
    startTransition(async()=>{
      try{
        const result=await createExpenseCorrectionDraftAction({id:expense.id,expectedVersion:expense.version,idempotencyKey:key.current,
          amount:amount.trim().replace(",","."),reason:form.get("reason")});
        if(!result.ok)setError(result.code);else router.push(`/${locale}/app/expenses/${result.data.id}`);
      }catch{setError("error");}
    });
  }}>
    {error?<p role="alert" data-testid="expense-correction-error">{t(error)}</p>:null}
    <fieldset className="resource-form" disabled={!ready||pending}><legend>{t("correctionTitle")}</legend><p>{t("correctionGuidance")}</p>
      <label className="field"><span>{t("correctedAmount",{currency:expense.currency})}</span><input name="amount" data-testid="expense-corrected-amount" type="text" inputMode="decimal" dir="ltr" maxLength={19} required /></label>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="expense-correction-reason" minLength={6} maxLength={500} required /></label>
      <div className="form-actions"><button className="secondary-button" data-testid="expense-correction-create" type="submit">{t(pending?"saving":"prepareCorrection")}</button></div>
    </fieldset>
  </form>;
}
