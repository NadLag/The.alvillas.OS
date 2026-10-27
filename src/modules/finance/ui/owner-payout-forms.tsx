"use client";

import { useEffect,useRef,useState,useTransition } from "react";
import Link from "next/link";
import { useLocale,useTranslations } from "next-intl";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import { normalizeMoneyInput } from "@/i18n/money-input";
import { ownerPayoutDraftFormSchema } from "../domain/owner-payout";
import { createOwnerPayoutAction,ownerPayoutCommandAction,scheduleOwnerPayoutAction } from "../application/owner-payout-actions";
import type { getOwnerPayoutWorkspace } from "../application/owner-payout-workspace-service";

type ErrorCode="forbidden"|"conflict"|"configuration"|"validation"|"periodClosed"|"clock"|"error";
function textField(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value:"";}
function ClockOccurrence(){
  const t=useTranslations("OwnerPayouts");
  return <label className="field"><span>{t("clockOccurrence")}</span><select name="occurrence" defaultValue="reject">
    <option value="reject">{t("uniqueClock")}</option><option value="earlier">{t("earlierClock")}</option><option value="later">{t("laterClock")}</option>
  </select></label>;
}
export function OwnerPayoutDraftForm({editor}:{editor:Awaited<ReturnType<typeof getOwnerPayoutWorkspace>>}){
  const t=useTranslations("OwnerPayouts"),locale=useLocale(),router=useRouter(),pathname=usePathname(),query=useSearchParams(),identity=useRef<string|null>(null);
  const [ready,setReady]=useState(false),[pending,startTransition]=useTransition(),[error,setError]=useState<ErrorCode|null>(null);
  const [currency,setCurrency]=useState(editor.baseCurrency),[method,setMethod]=useState("");
  useEffect(()=>{queueMicrotask(()=>{identity.current=crypto.randomUUID();setReady(true);});},[]);
  const navigate=(key:"fundingAccountId"|"reservationId",value:string)=>{
    const next=new URLSearchParams(query);if(value)next.set(key,value);else next.delete(key);
    startTransition(()=>router.replace(`${pathname}?${next}`));
  };
  const nextFunding=new URLSearchParams(query);if(editor.fundingNext)nextFunding.set("fundingAfter",editor.fundingNext);
  return <section aria-label={t("create")}>
    <h2>{t("create")}</h2>
    <form className="resource-form" data-testid="payout-source-search" onSubmit={event=>{
      event.preventDefault();if(pending)return;const data=new FormData(event.currentTarget),next=new URLSearchParams(query);next.delete("fundingAfter");
      for(const key of ["fundingQuery","bookingQuery"]){const value=textField(data,key).trim();if(value)next.set(key,value);else next.delete(key);}
      startTransition(()=>router.replace(`${pathname}?${next}`));
    }}><div className="form-grid two">
      <label className="field"><span>{t("searchFunding")}</span><input name="fundingQuery" maxLength={120} defaultValue={query.get("fundingQuery")??""} disabled={pending}/></label>
      <label className="field"><span>{t("searchBooking")}</span><input name="bookingQuery" maxLength={120} defaultValue={query.get("bookingQuery")??""} disabled={pending}/></label>
    </div><div className="form-actions"><button className="secondary-button" type="submit" disabled={pending}>{t("search")}</button>
      {editor.fundingNext?<Link className="secondary-button" aria-disabled={pending} onClick={event=>{if(pending)event.preventDefault();}} href={`${pathname}?${nextFunding}`}>{t("moreFunding")}</Link>:null}</div></form>
    {!editor.methods.length?<p role="status">{t("noMethods")}</p>:null}
    {!editor.accounts.length?<p role="status">{t("noFunding")}</p>:null}
    {editor.canCreate&&editor.methods.length&&editor.accounts.length?<form className="resource-form" data-testid="payout-draft-form" aria-busy={pending} onSubmit={event=>{
      event.preventDefault();if(!identity.current||pending)return;const data=new FormData(event.currentTarget);setError(null);
      const input=ownerPayoutDraftFormSchema.safeParse({ownerId:editor.owner.id,propertyId:editor.property.id,reservationId:textField(data,"reservationId")||undefined,
        payoutMethodId:method,fundingAccountId:data.get("fundingAccountId"),amount:normalizeMoneyInput(textField(data,"amount")),currency,
        purpose:data.get("purpose"),reason:data.get("reason"),idempotencyKey:identity.current,expectedSettlementLocal:textField(data,"expectedSettlementLocal")||undefined,
        occurrence:data.get("occurrence")});
      if(!input.success){setError("validation");return;}
      startTransition(async()=>{try{const result=await createOwnerPayoutAction(input.data);if(!result.ok)setError(result.code);else router.push(`/${locale}/app/payouts/${result.data.id}`);}catch{setError("error");}});
    }}>
      {error?<p role="alert" data-testid="payout-error">{t(error)}</p>:null}
      <fieldset className="resource-form" disabled={!ready||pending}><legend>{t("details")}</legend><div className="form-grid two">
        <label className="field"><span>{t("amount")}</span><input name="amount" data-testid="payout-amount" inputMode="decimal" dir="ltr" maxLength={19} required onInput={event=>{event.currentTarget.value=normalizeMoneyInput(event.currentTarget.value);}}/></label>
        <label className="field"><span>{t("currency")}</span><select data-testid="payout-currency" value={currency} required onChange={event=>{setCurrency(event.target.value);setMethod("");}}>
          {editor.currencies.map(value=><option value={value.code} key={value.code}>{value.code}</option>)}</select></label>
        <label className="field"><span>{t("recipientMethod")}</span><select data-testid="payout-method" value={method} required onChange={event=>setMethod(event.target.value)}><option value="">{t("chooseMethod")}</option>
          {editor.methods.filter(value=>value.currency===currency).map(value=><option value={value.id} key={value.id}>{value.label}</option>)}</select></label>
        <label className="field"><span>{t("funding")}</span><select name="fundingAccountId" data-testid="payout-funding" value={query.get("fundingAccountId")??""} required onChange={event=>navigate("fundingAccountId",event.target.value)}>
          <option value="">{t("chooseFunding")}</option>{editor.accounts.map(value=><option value={value.id} key={value.id}>{value.name}</option>)}</select></label>
      </div>
      <label className="field"><span>{t("purpose")}</span><textarea name="purpose" data-testid="payout-purpose" minLength={3} maxLength={500} dir="auto" required/></label>
      <label className="field"><span>{t("booking")}</span><select name="reservationId" data-testid="payout-booking" value={query.get("reservationId")??""} onChange={event=>navigate("reservationId",event.target.value)}>
        <option value="">{t("noBooking")}</option>{editor.reservations.map(value=><option value={value.id} key={value.id}>{value.reference}</option>)}</select></label>
      <details><summary>{t("expectedSettlement")}</summary><p>{t("expectedSettlementHelp")}</p><p>{t("timezone",{timezone:editor.property.timezone})}</p>
        <label className="field"><span>{t("expectedSettlement")}</span><input name="expectedSettlementLocal" data-testid="payout-expected-settlement" type="datetime-local" step="1"/></label><ClockOccurrence/></details>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="payout-reason" minLength={6} maxLength={500} dir="auto" required/></label>
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="payout-create">{t(pending?"saving":"create")}</button></div>
      </fieldset>
    </form>:null}
  </section>;
}

type Command="submit"|"schedule"|"pay"|"reverse"|"fail"|"cancel";
export function OwnerPayoutRefresh(){const t=useTranslations("OwnerPayouts"),router=useRouter();return <button className="secondary-button" type="button" onClick={()=>router.refresh()}>{t("refresh")}</button>;}
export function OwnerPayoutCommandForm({id,version,command,defaultSchedule}:{id:string;version:number;command:Command;defaultSchedule?:string}){
  const t=useTranslations("OwnerPayouts"),router=useRouter(),[pending,startTransition]=useTransition(),[error,setError]=useState<ErrorCode|null>(null);
  return <form className="resource-form" data-testid={`payout-${command}-form`} aria-busy={pending} onSubmit={event=>{
    event.preventDefault();if(pending)return;const data=new FormData(event.currentTarget),input={id,expectedVersion:version,reason:data.get("reason")};setError(null);
    startTransition(async()=>{try{
      const result=command==="schedule"?await scheduleOwnerPayoutAction({...input,scheduledLocal:data.get("scheduledLocal"),occurrence:data.get("occurrence")}):
        await ownerPayoutCommandAction({...input,...(command==="pay"?{paymentReference:data.get("paymentReference")}: {})},command);
      if(!result.ok)setError(result.code);else router.refresh();
    }catch{setError("error");}});
  }}>
    <h2>{t(`commands.${command}`)}</h2><p>{t(`guidance.${command}`)}</p>
    {error?<p role="alert" data-testid="payout-error">{t(error)}</p>:null}
    <fieldset className="resource-form" disabled={pending}><legend>{t("confirmation")}</legend>
      {command==="schedule"?<><label className="field"><span>{t("scheduledFor")}</span><input name="scheduledLocal" data-testid="payout-scheduled-local" type="datetime-local" step="1" defaultValue={defaultSchedule} required/></label><ClockOccurrence/></>:null}
      {command==="pay"?<label className="field"><span>{t("paymentReference")}</span><input name="paymentReference" data-testid="payout-payment-reference" minLength={3} maxLength={160} dir="auto" required/></label>:null}
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid={`payout-${command}-reason`} minLength={6} maxLength={500} dir="auto" required/></label>
      <div className="form-actions"><button className={command==="cancel"||command==="reverse"||command==="fail"?"secondary-button":"primary-button"} type="submit" data-testid={`payout-${command}`}>{t(pending?"saving":`commands.${command}`)}</button></div>
    </fieldset>
    {error==="conflict"?<button className="secondary-button" type="button" onClick={()=>router.refresh()}>{t("refresh")}</button>:null}
  </form>;
}
