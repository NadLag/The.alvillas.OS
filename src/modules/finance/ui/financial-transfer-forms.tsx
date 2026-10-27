"use client";

import { useEffect,useRef,useState,useTransition } from "react";
import Link from "next/link";
import { useRouter,usePathname,useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { financialTransferKinds,financialTransferSchema } from "../domain/financial-transfer";
import { postFinancialTransferAction,voidFinancialTransferAction } from "../application/financial-transfer-actions";

type ErrorCode="forbidden"|"conflict"|"validation"|"unavailable"|"closed"|"error";
export function FinancialTransferForm({accounts,currencies,baseCurrency,next,canCreate}:{accounts:Array<{id:string;name:string}>;currencies:Array<{code:string}>;baseCurrency:string;next?:string;canCreate:boolean}){
  const t=useTranslations("FinancialTransfers"),router=useRouter(),pathname=usePathname(),query=useSearchParams(),key=useRef<string|null>(null);
  const [ready,setReady]=useState(false),[pending,startTransition]=useTransition(),[error,setError]=useState<ErrorCode|null>(null),[saved,setSaved]=useState<string|null>(null);
  useEffect(()=>{queueMicrotask(()=>{key.current=crypto.randomUUID();setReady(true)})},[]);
  function selection(name:"from"|"to",value:string){const params=new URLSearchParams(query);params.delete("historyAfter");if(value)params.set(name,value);else params.delete(name);startTransition(()=>router.replace(`${pathname}?${params}`))}
  const nextQuery=new URLSearchParams(query);if(next)nextQuery.set("after",next);
  return <div className="financial-transfer-editor">
    <form className="resource-form" data-testid="transfer-account-search" onSubmit={event=>{
      event.preventDefault();if(pending)return;const params=new URLSearchParams(query),raw=new FormData(event.currentTarget).get("q"),value=typeof raw==="string"?raw.trim():"";params.delete("after");
      if(value)params.set("q",value);else params.delete("q");startTransition(()=>router.replace(`${pathname}?${params}`));
    }}>
      <label className="field"><span>{t("searchAccounts")}</span><input name="q" maxLength={120} defaultValue={query.get("q")??""} disabled={pending}/></label>
      <div className="form-actions"><button className="secondary-button" type="submit" disabled={pending}>{t("search")}</button>
        {next?<Link className="secondary-button" data-testid="transfer-account-next" aria-disabled={pending} onClick={event=>{if(pending)event.preventDefault()}} href={`${pathname}?${nextQuery}`}>{t("nextAccounts")}</Link>:null}</div>
    </form>
    {canCreate?<form className="resource-form financial-transfer-form" data-testid="financial-transfer-form" aria-busy={pending} onSubmit={event=>{
      event.preventDefault();if(!key.current||pending)return;const element=event.currentTarget,form=new FormData(element);setError(null);setSaved(null);
      const amount=form.get("amount");
      const input=financialTransferSchema.safeParse({fromAccountId:form.get("fromAccountId"),toAccountId:form.get("toAccountId"),kind:form.get("kind"),amount:typeof amount==="string"?amount.replace(",","."):amount,currency:form.get("currency"),purpose:form.get("purpose"),reason:form.get("reason"),idempotencyKey:key.current});
      if(!input.success){setError("validation");return}
      startTransition(async()=>{try{const result=await postFinancialTransferAction(input.data);if(!result.ok){setError(result.code);return}setSaved(result.data.id);key.current=crypto.randomUUID();element.reset();router.refresh()}catch{setError("error")}});
    }}>
      <h2>{t("create")}</h2><p>{t("separation")}</p>
      {error?<p role="alert" data-testid="transfer-error">{t(error)}</p>:null}
      {saved?<p role="status" data-testid="transfer-saved">{t("saved")}</p>:null}
      <fieldset className="resource-form" disabled={!ready||pending}>
        <legend>{t("details")}</legend>
        <div className="form-grid two">
          <label className="field"><span>{t("from")}</span><select name="fromAccountId" data-testid="transfer-from" value={query.get("from")??""} required onChange={event=>selection("from",event.target.value)}>
            <option value="">{t("selectAccount")}</option>{accounts.map(account=><option value={account.id} key={account.id}>{account.name}</option>)}
          </select></label>
          <label className="field"><span>{t("to")}</span><select name="toAccountId" data-testid="transfer-to" value={query.get("to")??""} required onChange={event=>selection("to",event.target.value)}>
            <option value="">{t("selectAccount")}</option>{accounts.map(account=><option value={account.id} key={account.id}>{account.name}</option>)}
          </select></label>
          <label className="field"><span>{t("kind")}</span><select name="kind" data-testid="transfer-kind" defaultValue="" required><option value="">{t("selectKind")}</option>{financialTransferKinds.map(kind=><option key={kind} value={kind}>{t(`kinds.${kind}`)}</option>)}</select></label>
          <label className="field"><span>{t("amount")}</span><input name="amount" data-testid="transfer-amount" inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,15})(?:[.,][0-9]{1,2})?" required/></label>
          <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="transfer-currency" defaultValue={currencies.some(currency=>currency.code===baseCurrency)?baseCurrency:""} required><option value="">{t("selectCurrency")}</option>{currencies.map(currency=><option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></label>
        </div>
        <label className="field"><span>{t("purpose")}</span><input name="purpose" data-testid="transfer-purpose" minLength={3} maxLength={500} required/></label>
        <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="transfer-reason" minLength={6} maxLength={500} required/></label>
        <div className="form-actions"><button className="primary-button" type="submit" data-testid="transfer-submit">{t(pending?"saving":"create")}</button></div>
      </fieldset>
    </form>:null}
  </div>;
}
export function FinancialTransferVoidForm({id}:{id:string}){
  const t=useTranslations("FinancialTransfers"),router=useRouter(),[pending,startTransition]=useTransition(),[error,setError]=useState<ErrorCode|null>(null);
  return <form className="resource-form financial-transfer-form" data-testid="transfer-void-form" aria-busy={pending} onSubmit={event=>{
    event.preventDefault();if(pending)return;const reason=new FormData(event.currentTarget).get("reason");setError(null);
    startTransition(async()=>{try{const result=await voidFinancialTransferAction({id,reason});if(!result.ok){setError(result.code);return}router.refresh()}catch{setError("error")}});
  }}>
    {error?<p role="alert">{t(error)}</p>:null}
    <label className="field"><span>{t("voidReason")}</span><textarea name="reason" minLength={6} maxLength={500} required disabled={pending}/></label>
    <div className="form-actions"><button className="secondary-button" type="submit" disabled={pending}>{t(pending?"saving":"void")}</button></div>
  </form>;
}
