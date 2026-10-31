"use client";
import { useCallback,useState,type Ref } from "react";
import { useTranslations } from "next-intl";
import { paymentAccountChoicePageSchema,type PaymentAccountSource } from "../domain/payment-account-choices";
import { useCompensationRead } from "./use-compensation-read";

export function PaymentAccountPicker({source,testId,name,label,initialValue="",onValueChange,onBlur,inputRef,disabled=false}:{source:PaymentAccountSource;testId:string;name:string;label:string;initialValue?:string;onValueChange?:(value:string)=>void;onBlur?:()=>void;inputRef?:Ref<HTMLSelectElement>;disabled?:boolean}){
  const t=useTranslations("PaymentAccounts"),[query,setQuery]=useState(""),[filter,setFilter]=useState(""),[after,setAfter]=useState<string|undefined>(),[selected,setSelected]=useState(initialValue);
  const invalidate=useCallback(()=>{setSelected("");onValueChange?.("");},[onValueChange]);
  const read=useCompensationRead("/api/finance/payment-accounts",paymentAccountChoicePageSchema,invalidate,JSON.stringify({source,query:filter,after,selectedId:selected||undefined}));
  const accounts=read.data?.accounts??[],pinned=read.data?.selected;
  const selectedVisible=Boolean(selected&&(accounts.some(row=>row.id===selected)||pinned?.id===selected));
  return <div className="resource-form" aria-busy={read.pending}>
    <div className="form-grid two"><label className="field"><span>{t("searchLabel")}</span><input data-testid={`${testId}-query`} value={query} maxLength={120} onChange={event=>setQuery(event.target.value)} disabled={disabled}/></label>
      <button className="secondary-button" type="button" data-testid={`${testId}-search`} disabled={disabled||read.pending} onClick={()=>{setAfter(undefined);setFilter(query.trim());}}>{t("search")}</button></div>
    <label className="field"><span>{label}</span><select ref={inputRef} name={name} data-testid={testId} value={selectedVisible?selected:""} onChange={event=>{setSelected(event.target.value);onValueChange?.(event.target.value);}} onBlur={onBlur} disabled={disabled||read.pending||Boolean(read.error)} required>
      <option value="" disabled>{t("choose")}</option>{pinned&&!accounts.some(row=>row.id===pinned.id)?<option value={pinned.id}>{pinned.name}</option>:null}
      {accounts.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
    </select></label>
    {read.pending?<p role="status">{t("loading")}</p>:read.error?<p role="alert">{t(read.error==="offline"?"offline":read.error==="forbidden"?"forbidden":"unavailable")}</p>:!accounts.length?<p role="status">{t("empty")}</p>:null}
    <div className="form-actions">{read.data?.next?<button type="button" className="secondary-button" data-testid={`${testId}-next`} disabled={disabled||read.pending} onClick={()=>setAfter(read.data!.next!)}>{t("next")}</button>:null}
      <button type="button" className="secondary-button" data-testid={`${testId}-refresh`} disabled={disabled||read.pending} onClick={()=>void read.refresh()}>{t("refresh")}</button></div>
  </div>;
}
