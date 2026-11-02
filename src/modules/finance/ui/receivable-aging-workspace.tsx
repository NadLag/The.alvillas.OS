"use client";
import {useCallback,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import {EmptyState,SkeletonBlock} from "@/design-system/shells";
import {localizedText} from "@/i18n/content";
import {formatCurrencyAmount,formatDate,formatDateTime} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import {receivableAgingPageSchema} from "../domain/receivable-aging";
import {receivableEditorSchema} from "../domain/receivable-workspace";
import {useCompensationRead} from "./use-compensation-read";

export function ReceivableAgingWorkspace({locale}:{locale:AppLocale}){
 const t=useTranslations("ReceivableAging");
 const common=useTranslations("Receivables");
 const[selectedCurrency,setSelectedCurrency]=useState("");
 const[draftBucket,setDraftBucket]=useState("");
 const[bucket,setBucket]=useState("");
 const[draftSearch,setDraftSearch]=useState("");
 const[search,setSearch]=useState("");
 const[after,setAfter]=useState<string>();
 const invalidate=useCallback(()=>{setSelectedCurrency("");setDraftBucket("");setBucket("");setDraftSearch("");setSearch("");setAfter(undefined);},[]);
 const editor=useCompensationRead("/api/finance/receivables/editor",receivableEditorSchema,invalidate);
 const currency=selectedCurrency||editor.data?.source.baseCurrency;
 const body=currency?JSON.stringify({currency,search,...bucket?{bucket}:{},...after?{after}:{}}):undefined;
 const read=useCompensationRead(currency?"/api/finance/receivables/aging":null,receivableAgingPageSchema,invalidate,body);
 const error=editor.error??read.error;
 const pending=editor.pending||read.pending;
 const source=!error&&!pending?read.data?.source:null;
 const money=(value:{amount:string;currency:string})=>formatCurrencyAmount(locale,value.amount,value.currency);
 const count=(value:string)=>new Intl.NumberFormat(locale).format(BigInt(value));
 const label=(key:string,labels:Record<string,string|undefined>|null)=>labels?localizedText(labels,locale):t(key==="UNSCHEDULED"?"unscheduled":"notDue");
 function apply(event:FormEvent<HTMLFormElement>){event.preventDefault();const next=draftSearch.trim(),same=next===search&&draftBucket===bucket&&after===undefined;setSearch(next);setBucket(draftBucket);setAfter(undefined);if(same)void read.refresh();}
 function refresh(){const changed=!!after||bucket!==""||search!=="";setAfter(undefined);setDraftBucket("");setBucket("");setDraftSearch("");setSearch("");if(!changed)void read.refresh();}
 return <section className="compensation-history" aria-labelledby="receivable-aging-title" data-testid="receivable-aging-workspace">
  <h2 id="receivable-aging-title">{t("title")}</h2><p>{t("guidance")}</p>
  {error==="forbidden"?<p role="alert">{t("forbidden")}</p>:<>
   <form className="compensation-filters" onSubmit={apply} aria-label={t("filters")}>
    <label className="field"><span>{t("search")}</span><input value={draftSearch} maxLength={120} onChange={event=>setDraftSearch(event.target.value)} disabled={pending} data-testid="receivable-aging-search"/></label>
    <label className="field"><span>{t("currency")}</span><select value={currency??""} disabled={editor.pending||!editor.data} onChange={event=>{setSelectedCurrency(event.target.value);setAfter(undefined);setDraftBucket("");setBucket("");}} data-testid="receivable-aging-currency">{editor.data?.source.currencies.map(code=><option key={code} value={code}>{code}</option>)}</select></label>
    <label className="field"><span>{t("band")}</span><select value={draftBucket} onChange={event=>setDraftBucket(event.target.value)} disabled={pending} data-testid="receivable-aging-band"><option value="">{t("allBands")}</option>{source?.buckets.map(group=><option key={group.key} value={group.key}>{label(group.key,group.labels)}</option>)}</select></label>
    <button type="submit" className="secondary-button" disabled={pending||!currency} data-testid="receivable-aging-apply">{t("apply")}</button>
    <button type="button" className="secondary-button" onClick={refresh} disabled={pending||error==="offline"} data-testid="receivable-aging-refresh">{t("refresh")}</button>
   </form>
   {pending?<><p role="status">{t("loading")}</p><SkeletonBlock rows={3}/></>:null}
   {error?<p role={error==="offline"?"status":"alert"}>{t(error==="offline"?"offline":error==="configuration_unavailable"?"configuration":"unavailable")}</p>:null}
   {source?<>
    <p>{t("asOf",{date:formatDateTime(locale,new Date(source.at),{timeZone:source.timezone})})}</p>
    <p>{t("total")} <strong className="compensation-numeric" data-testid="receivable-aging-total">{money(source.totalOutstanding)}</strong> <span>{t("claims",{count:count(source.totalCount)})}</span></p>
    <dl className="compensation-cost-allocation" data-testid="receivable-aging-buckets">{source.buckets.map(group=><div key={group.key}><dt dir="auto">{label(group.key,group.labels)}</dt><dd className="compensation-numeric">{money(group.outstanding)}</dd><dd>{t("claims",{count:count(group.count)})}</dd></div>)}</dl>
    {source.items.length===0?<EmptyState>{t("empty")}</EmptyState>:null}
    <ol className="compensation-source-list">{source.items.map(item=><li className="compensation-source" key={item.id} data-testid="receivable-aging-item">
     <strong dir="auto">{item.purpose}</strong><span>{common(`kinds.${item.party.kind}`)}</span>
     <span>{item.dueOn?t("dueOn",{date:formatDate(locale,new Date(item.dueOn+"T12:00:00Z"),{timeZone:"UTC"})}):t("unscheduled")}</span>
     {item.daysPastDue!==null&&item.daysPastDue>0?<span>{t("daysPastDue",{count:new Intl.NumberFormat(locale).format(item.daysPastDue)})}</span>:null}
     <dl className="compensation-cost-allocation"><div><dt>{t("assigned")}</dt><dd className="compensation-numeric">{money(item.assigned)}</dd></div><div><dt>{t("collected")}</dt><dd className="compensation-numeric">{money(item.collected)}</dd></div><div><dt>{t("outstanding")}</dt><dd className="compensation-numeric">{money(item.outstanding)}</dd></div></dl>
    </li>)}</ol>
    <div className="app-actions">{after?<button type="button" className="secondary-button" onClick={()=>setAfter(undefined)} data-testid="receivable-aging-first">{t("firstPage")}</button>:null}{source.next?<button type="button" className="secondary-button" onClick={()=>setAfter(source.next!)} data-testid="receivable-aging-next">{t("nextPage")}</button>:null}</div>
   </>:null}
  </>}
 </section>;
}
