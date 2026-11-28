"use client";
import Link from "next/link";
import {useCallback,useEffect,useState} from "react";
import {useLocale,useTranslations} from "next-intl";
import {expensePurchaseChoicePage} from "../domain/expense-purchase-choices";
import {useCompensationRead} from "./use-compensation-read";
export type PurchaseFields={fundingKind:"COMPANY"|"PERSONAL";purchaserId:string;supplierId:string;receiptVersionId:string};
type Change=(field:keyof PurchaseFields,value:string)=>void;
function SourcePicker({propertyId,reservationId,kind,label,value,onChange}:{propertyId:string;reservationId?:string;kind:"PURCHASER"|"SUPPLIER"|"RECEIPT";label:string;value:string;onChange:(id:string)=>void}){
 const t=useTranslations("PurchaseFunding"),[query,setQuery]=useState(""),[filter,setFilter]=useState(""),[page,setPage]=useState(1),[after,setAfter]=useState<string|undefined>();
 const invalidate=useCallback(()=>onChange(""),[onChange]);
 const read=useCompensationRead("/api/finance/expense-purchase-choices",expensePurchaseChoicePage,invalidate,JSON.stringify({propertyId,reservationId,kind,query:filter,page,after}));
 const clear=read.clear;
 useEffect(()=>{const hide=()=>{if(document.hidden)clear("unavailable");},leave=()=>clear("unavailable");document.addEventListener("visibilitychange",hide);window.addEventListener("pagehide",leave);return()=>{document.removeEventListener("visibilitychange",hide);window.removeEventListener("pagehide",leave);};},[clear]);
 const visible=read.data?.items.some(item=>item.id===value);
 return<div className="resource-form" data-testid={`purchase-${kind.toLowerCase()}`} aria-busy={read.pending}><label className="field"><span>{label}</span><select value={visible?value:""} onChange={event=>onChange(event.target.value)} disabled={read.pending||Boolean(read.error)} required><option value="" disabled>{t("choose")}</option>{read.data?.items.map(item=><option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
  <div className="form-grid two"><label className="field"><span>{t("search")}</span><input value={query} maxLength={120} onChange={event=>setQuery(event.target.value)}/></label><button type="button" className="secondary-button" disabled={read.pending} onClick={()=>{invalidate();setPage(1);setAfter(undefined);setFilter(query.trim());}}>{t("search")}</button></div>
  {read.pending?<p role="status">{t("loading")}</p>:read.error?<p role="alert">{t(read.error==="offline"?"offline":"unavailable")}</p>:!read.data?.items.length?<p role="status">{t("empty")}</p>:null}
  <div className="form-actions">{read.data?.next?<button type="button" className="secondary-button" onClick={()=>{invalidate();if(kind==="PURCHASER")setPage(Number(read.data!.next));else setAfter(read.data!.next!);}}>{t("next")}</button>:null}<button type="button" className="secondary-button" disabled={read.pending} onClick={()=>{invalidate();void read.refresh();}}>{t("refresh")}</button></div>
 </div>;
}
export function ExpensePurchaseFields({propertyId,reservationId,value,onChange}:{propertyId:string;reservationId?:string;value:PurchaseFields;onChange:Change}){
 const t=useTranslations("PurchaseFunding"),locale=useLocale();
 const purchaser=useCallback((id:string)=>onChange("purchaserId",id),[onChange]);
 const supplier=useCallback((id:string)=>onChange("supplierId",id),[onChange]);
 const receipt=useCallback((id:string)=>onChange("receiptVersionId",id),[onChange]);
 return<fieldset className="resource-form" data-testid="expense-purchase-fields"><legend>{t("title")}</legend><p>{t("help")}</p><label className="field"><span>{t("funding")}</span><select value={value.fundingKind} onChange={event=>onChange("fundingKind",event.target.value)}><option value="COMPANY">{t("company")}</option><option value="PERSONAL">{t("personal")}</option></select></label><p>{t(value.fundingKind==="PERSONAL"?"personalHelp":"companyHelp")}</p>
  <SourcePicker propertyId={propertyId} reservationId={reservationId} kind="PURCHASER" label={t("purchaser")} value={value.purchaserId} onChange={purchaser}/><SourcePicker propertyId={propertyId} reservationId={reservationId} kind="SUPPLIER" label={t("supplier")} value={value.supplierId} onChange={supplier}/><SourcePicker propertyId={propertyId} reservationId={reservationId} kind="RECEIPT" label={t("receipt")} value={value.receiptVersionId} onChange={receipt}/><Link className="secondary-button" prefetch={false} href={`/${locale}/app/documents?property=${propertyId}`}>{t("archive")}</Link><p>{t("receiptHelp")}</p>
 </fieldset>;
}
