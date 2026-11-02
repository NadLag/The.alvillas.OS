"use client";
import {useCallback,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import {z} from "zod";
import {EmptyState,SkeletonBlock,StatusBadge} from "@/design-system/shells";
import {formatCurrencyAmount,formatDateTime} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import {receivableCollectionReviewInput,receivableCollectionReviewSchema,receivableCollectionVoidReviewSchema,receivableCollectionViewSchema} from "../domain/receivable-collection";
import {receivableCollectionEditorSchema,receivableCollectionHistorySchema} from "../domain/receivable-collection-workspace";
import {receivableHistorySchema} from "../domain/receivable-workspace";
import {useCompensationRead} from "./use-compensation-read";
import {useReceivableCollectionCommand,useReceivableCollectionReversalCommand} from "./use-receivable-collection-command";
type Collection=z.infer<typeof receivableCollectionViewSchema>;
const receiptSchema=z.object({collection:receivableCollectionViewSchema}).strict();
const money=(locale:AppLocale,value:{amount:string;currency:string})=>formatCurrencyAmount(locale,value.amount,value.currency);
function ReadError({error,retry}:{error:string;retry:()=>Promise<void>}){const t=useTranslations("Receivables");return <div className="compensation-notice" role="alert"><p>{t(error)}</p><button type="button" className="secondary-button" onClick={()=>{void retry();}}>{t("retryRead")}</button></div>;}
function ReceiptForm({locale,scope,id,onChanged}:{locale:AppLocale;scope:string;id:string;onChanged:()=>void}){
 const t=useTranslations("ReceivableCollections");
 const common=useTranslations("Receivables");
 const [amount,setAmount]=useState("");
 const [method,setMethod]=useState("");
 const [destination,setDestination]=useState("");
 const [at,setAt]=useState(()=>new Date().toISOString().slice(0,19));
 const [reference,setReference]=useState("");
 const [purpose,setPurpose]=useState("");
 const [reason,setReason]=useState("");
 const [confirmed,setConfirmed]=useState(false);
 const [validation,setValidation]=useState(false);
 const [after,setAfter]=useState<string>();
 const [search,setSearch]=useState("");
 const [appliedSearch,setAppliedSearch]=useState("");
 const [reviewInput,setReviewInput]=useState<z.infer<typeof receivableCollectionReviewInput>|null>(null);
 const [receipt,setReceipt]=useState<string|null>(null);
 const invalidate=useCallback(()=>{setAmount("");setMethod("");setDestination("");setAt("");setReference("");setPurpose("");setReason("");setConfirmed(false);setValidation(false);setAfter(undefined);setSearch("");setAppliedSearch("");setReviewInput(null);setReceipt(null);},[setAmount,setMethod,setDestination,setAt,setReference,setPurpose,setReason,setConfirmed,setValidation,setAfter,setSearch,setAppliedSearch,setReviewInput,setReceipt]);
 const succeeded=useCallback((value:{collection:Collection})=>{setReceipt(value.collection.id);onChanged();},[setReceipt,onChanged]);
 const command=useReceivableCollectionCommand({scope,id,onSuccess:succeeded,onInvalidate:invalidate});
 const deny=command.deny;
 const invalidateRead=useCallback(()=>{if(navigator.onLine)deny();else invalidate();},[deny,invalidate]);
 const readable=["ready","sending"].includes(command.state);
 const locked=command.state!=="ready";
 const editor=useCompensationRead(readable&&id?"/api/finance/receivables/collections/editor":null,receivableCollectionEditorSchema,invalidateRead,JSON.stringify({assignmentId:id,search:appliedSearch,...after?{after}:{}}));
 const review=useCompensationRead(readable&&reviewInput?"/api/finance/receivables/collections/review":null,receivableCollectionReviewSchema,invalidateRead,reviewInput?JSON.stringify(reviewInput):undefined);
 const liveReceipt=useCompensationRead(command.state==="succeeded"&&receipt?"/api/finance/receivables/collections/read":null,receiptSchema,invalidateRead,receipt?JSON.stringify({id:receipt}):undefined);
 const resetReview=()=>{setReviewInput(null);setConfirmed(false);setValidation(false);};
 function prepare(){let receivedAt="";try{receivedAt=new Date(at+"Z").toISOString();}catch{/* The input schema reports the invalid explicit UTC instant. */}const parsed=receivableCollectionReviewInput.safeParse({assignmentId:id,destinationAccountId:destination,amount,currency:editor.data?.source.assignment.amount.currency,method,receivedAt,externalReference:reference||null,purpose});if(!parsed.success){setValidation(true);return;}setValidation(false);setReviewInput(parsed.data);setConfirmed(false);}
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!reviewInput||!review.data||!confirmed)return;await command.send({...reviewInput,reviewFingerprint:review.data.reviewFingerprint,reason});}
 if(command.state==="succeeded"&&receipt){if(liveReceipt.pending)return <SkeletonBlock rows={3}/>;if(liveReceipt.error)return <ReadError error={liveReceipt.error} retry={liveReceipt.refresh}/>;if(liveReceipt.data)return <section className="compensation-notice" data-testid="receivable-collection-confirmed"><p role="status">{t("receiptConfirmed")}</p><strong className="compensation-total">{money(locale,liveReceipt.data.collection.amount)}</strong><p dir="auto">{liveReceipt.data.collection.purpose}</p><button type="button" className="secondary-button" data-testid="receivable-collection-another" onClick={()=>{invalidate();setAt(new Date().toISOString().slice(0,19));command.startNew();void editor.refresh();}}>{t("anotherReceipt")}</button></section>;}
 if(!readable)return <section className="compensation-notice"><p role={command.error?"alert":"status"}>{common(command.state)}</p>{command.state==="uncertain"?<button type="button" className="primary-button" data-testid="receivable-collection-retry" onClick={()=>{void command.send();}}>{common("retryExact")}</button>:null}{command.state!=="checking"?<button type="button" className="secondary-button" data-testid="receivable-collection-recover" onClick={()=>{void command.recover();}}>{common("recover")}</button>:null}</section>;
 if(!id)return null;
 if(editor.error)return <ReadError error={editor.error} retry={editor.refresh}/>;
 if(!editor.data)return <><p role="status">{common("loading")}</p><SkeletonBlock rows={4}/></>;
 return <form className="compensation-create-form" onSubmit={event=>{void submit(event);}} aria-busy={command.state==="sending"} data-testid="receivable-collection-form">
  <dl className="compensation-evidence"><div><dt>{t("originalClaim")}</dt><dd dir="auto">{editor.data.source.assignment.purpose}</dd></div><div><dt>{t("outstanding")}</dt><dd className="compensation-total">{money(locale,editor.data.source.outstandingAmount)}</dd></div></dl>
  {!editor.data.source.canCollect?<p role="status">{t("collectionUnavailable")}</p>:null}
  <fieldset className="resource-form" disabled={locked||!editor.data.source.canCollect}><legend>{t("receiptDetails")}</legend><p>{t("receiptGuidance")}</p>
   <label className="field"><span>{t("amount")}</span><input inputMode="decimal" autoComplete="off" value={amount} required onChange={event=>{setAmount(event.target.value);resetReview();}} data-testid="receivable-collection-amount"/></label>
   <label className="field"><span>{t("method")}</span><select value={method} required onChange={event=>{setMethod(event.target.value);resetReview();}} data-testid="receivable-collection-method"><option value="">{t("chooseMethod")}</option>{editor.data.source.methods.map(row=><option key={row.key} value={row.key}>{row.labels[locale]}</option>)}</select></label>
   <label className="field"><span>{t("accountSearch")}</span><input type="search" value={search} onChange={event=>setSearch(event.target.value)} data-testid="receivable-collection-account-search"/></label><button type="button" className="secondary-button" onClick={()=>{setAppliedSearch(search);setAfter(undefined);setDestination("");resetReview();}}>{common("search")}</button>
   <label className="field"><span>{t("destination")}</span><select value={destination} required onChange={event=>{setDestination(event.target.value);resetReview();}} data-testid="receivable-collection-destination"><option value="">{t("chooseDestination")}</option>{editor.data.source.accounts.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   {editor.data.source.accounts.length===0?<EmptyState>{t("emptyAccounts")}</EmptyState>:null}<div className="app-actions">{after?<button type="button" className="secondary-button" onClick={()=>{setAfter(undefined);setDestination("");resetReview();}}>{common("firstPage")}</button>:null}{editor.data.source.next?<button type="button" className="secondary-button" onClick={()=>{setAfter(editor.data!.source.next!);setDestination("");resetReview();}}>{common("nextPage")}</button>:null}</div>
   <label className="field"><span>{t("receivedAtUtc")}</span><input type="datetime-local" step="1" value={at} required onChange={event=>{setAt(event.target.value);resetReview();}} data-testid="receivable-collection-at"/></label>
   <label className="field"><span>{t("reference")}</span><input dir="auto" value={reference} maxLength={160} onChange={event=>{setReference(event.target.value);resetReview();}} data-testid="receivable-collection-reference"/></label>
   <label className="field"><span>{t("purpose")}</span><textarea dir="auto" value={purpose} minLength={3} maxLength={1000} required onChange={event=>{setPurpose(event.target.value);resetReview();}} data-testid="receivable-collection-purpose"/></label>
   <button type="button" className="secondary-button" onClick={prepare} data-testid="receivable-collection-review">{t("reviewReceipt")}</button>
  </fieldset>
  {review.pending&&reviewInput?<SkeletonBlock rows={3}/>:null}{review.error&&reviewInput?<ReadError error={review.error} retry={review.refresh}/>:null}{review.data&&reviewInput?<section className="compensation-create-review" data-testid="receivable-collection-evidence"><h3>{t("reviewTitle")}</h3><dl className="compensation-evidence"><div><dt>{t("amount")}</dt><dd className="compensation-total">{money(locale,review.data.collection.amount)}</dd></div><div><dt>{t("destination")}</dt><dd dir="auto">{review.data.collection.destination.name}</dd></div><div><dt>{t("method")}</dt><dd>{review.data.collection.method.labels[locale]}</dd></div><div><dt>{t("receivedAtUtc")}</dt><dd>{formatDateTime(locale,new Date(review.data.collection.receivedAt),{timeZone:"UTC"})}</dd></div><div><dt>{t("outstanding")}</dt><dd>{money(locale,review.data.source.outstandingAmount)}</dd></div></dl><p>{t("confirmGuidance")}</p></section>:null}
  <fieldset className="resource-form" disabled={locked||!editor.data.source.canCollect}><legend>{common("confirmation")}</legend><label className="field"><span>{common("reason")}</span><textarea dir="auto" value={reason} minLength={6} maxLength={500} required onChange={event=>setReason(event.target.value)} data-testid="receivable-collection-reason"/></label><label className="compensation-cost-check"><input type="checkbox" required checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} data-testid="receivable-collection-confirm"/><span>{t("confirmReceipt")}</span></label></fieldset>
  {validation||command.error?<p role="alert">{common(validation?"validation":command.error??"unavailable")}</p>:null}<button className="primary-button" disabled={locked||!editor.data.source.canCollect||!reviewInput||!review.data||review.pending||Boolean(review.error)||!confirmed} data-testid="receivable-collection-submit">{t(command.state==="sending"?"recording":"recordReceipt")}</button>
 </form>;
}
function Correction({item,scope,onChanged}:{item:Collection|undefined;scope:string;onChanged:()=>void}){
 const t=useTranslations("ReceivableCollections");
 const common=useTranslations("Receivables");
 const [reviewing,setReviewing]=useState(false);
 const [reason,setReason]=useState("");
 const [confirmed,setConfirmed]=useState(false);
 const invalidate=useCallback(()=>{setReviewing(false);setReason("");setConfirmed(false);},[setReviewing,setReason,setConfirmed]);
 const succeeded=useCallback(()=>{invalidate();onChanged();},[invalidate,onChanged]);
 const command=useReceivableCollectionReversalCommand({scope,id:item?.id??"",onSuccess:succeeded,onInvalidate:invalidate});
 const deny=command.deny;
 const invalidateRead=useCallback(()=>{if(navigator.onLine)deny();else invalidate();},[deny,invalidate]);
 const review=useCompensationRead(item&&reviewing&&command.state==="ready"?"/api/finance/receivables/collections/reverse/review":null,receivableCollectionVoidReviewSchema,invalidateRead,JSON.stringify({id:item?.id}));
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(item&&confirmed&&review.data)await command.send({id:item.id,reviewFingerprint:review.data.reviewFingerprint,reason});}
 if(command.state!=="ready")return <section className="compensation-notice"><p role="status">{common(command.state)}</p>{command.state==="uncertain"?<button type="button" className="secondary-button" onClick={()=>{void command.send();}}>{common("retryExact")}</button>:null}{command.state!=="checking"&&command.state!=="sending"?<button type="button" className="secondary-button" onClick={()=>{void command.recover();}}>{common("recover")}</button>:null}</section>;
 if(!item)return null;
 return <form className="resource-form" onSubmit={event=>{void submit(event);}} data-testid="receivable-collection-correction-form"><h4>{t("correctReceipt")}</h4><p>{t("correctionGuidance")}</p><button type="button" className="secondary-button" onClick={()=>setReviewing(true)} data-testid="receivable-collection-correction-review">{t("reviewCorrection")}</button>{reviewing&&review.pending?<SkeletonBlock rows={2}/>:null}{reviewing&&review.error?<ReadError error={review.error} retry={review.refresh}/>:null}{review.data?<><label className="field"><span>{common("reason")}</span><textarea dir="auto" minLength={6} maxLength={500} required value={reason} onChange={event=>setReason(event.target.value)} data-testid="receivable-collection-correction-reason"/></label><label className="compensation-cost-check"><input type="checkbox" checked={confirmed} required onChange={event=>setConfirmed(event.target.checked)} data-testid="receivable-collection-correction-confirm"/><span>{t("confirmCorrection")}</span></label><button className="primary-button" disabled={!confirmed||review.pending||Boolean(review.error)} data-testid="receivable-collection-correction-submit">{t("correctReceipt")}</button></>:null}</form>;
}
function CollectionHistory({locale,scope,onChanged,assignmentId}:{locale:AppLocale;scope:string;onChanged:()=>void;assignmentId?:string}){
 const t=useTranslations("ReceivableCollections");
 const common=useTranslations("Receivables");
 const [after,setAfter]=useState<string>();
 const [selected,setSelected]=useState<string>();
 const history=useCompensationRead("/api/finance/receivables/collections/history",receivableCollectionHistorySchema,undefined,JSON.stringify({...after?{after}:{},...assignmentId?{assignmentId}:{}}));
 return <section className="compensation-history" aria-labelledby="receivable-collection-history-title" data-testid="receivable-collection-history"><h3 id="receivable-collection-history-title">{t("history")}</h3>{history.pending?<><p role="status">{common("loading")}</p><SkeletonBlock rows={3}/></>:null}{history.error?<ReadError error={history.error} retry={history.refresh}/>:null}{history.data?.source.items.length===0?<EmptyState>{t("emptyHistory")}</EmptyState>:null}<ol className="compensation-source-list">{history.data?.source.items.map(item=><li key={item.id} className="compensation-source" data-testid="receivable-collection-history-item"><StatusBadge tone={item.reversal?"neutral":"success"}>{t(item.reversal?"corrected":"recorded")}</StatusBadge><strong className="compensation-numeric">{money(locale,item.amount)}</strong><strong dir="auto">{item.purpose}</strong><span>{item.method.labels[locale]}</span><p>{formatDateTime(locale,new Date(item.receivedAt),{timeZone:"UTC"})}</p>{item.externalReference?<p dir="auto">{item.externalReference}</p>:null}<p dir="auto">{item.reason}</p>{item.reversal?<p dir="auto">{item.reversal.reason}</p>:<button type="button" className="secondary-button" onClick={()=>setSelected(value=>value===item.id?undefined:item.id)} data-testid="receivable-collection-show-correction">{t("correctReceipt")}</button>}</li>)}</ol><Correction key={selected??"recover"} item={history.data?.source.items.find(item=>item.id===selected&&!item.reversal)} scope={scope} onChanged={onChanged}/><div className="app-actions">{after?<button type="button" className="secondary-button" onClick={()=>{setAfter(undefined);setSelected(undefined);}}>{common("firstPage")}</button>:null}{history.data?.source.next?<button type="button" className="secondary-button" onClick={()=>{setAfter(history.data!.source.next!);setSelected(undefined);}}>{common("nextPage")}</button>:null}</div></section>;
}
export function ReceivableCollectionWorkspace({locale,scope,onChanged}:{locale:AppLocale;scope:string;onChanged?:()=>void}){
 const t=useTranslations("ReceivableCollections");
 const common=useTranslations("Receivables");
 const [selected,setSelected]=useState("");
 const [after,setAfter]=useState<string>();
 const [draftSearch,setDraftSearch]=useState("");
 const [search,setSearch]=useState("");
 const [revision,setRevision]=useState(0);
 const invalidate=useCallback(()=>{setSelected("");setDraftSearch("");setSearch("");setAfter(undefined);},[setSelected]);
 const changed=useCallback(()=>{setRevision(value=>value+1);onChanged?.();},[setRevision,onChanged]);
 const assignments=useCompensationRead("/api/finance/receivables/assignments/history",receivableHistorySchema,invalidate,JSON.stringify({...after?{after}:{},...search?{search}:{}}));
 return <section className="compensation-create-form" aria-labelledby="receivable-collection-title" data-testid="receivable-collection-workspace"><h2 id="receivable-collection-title">{t("title")}</h2><p>{t("guidance")}</p><form className="compensation-filters" onSubmit={event=>{event.preventDefault();const next=draftSearch.trim(),same=next===search&&!after;setSearch(next);setAfter(undefined);setSelected("");if(same)void assignments.refresh();}}><label className="field"><span>{common("claimSearch")}</span><input value={draftSearch} maxLength={120} onChange={event=>setDraftSearch(event.target.value)} data-testid="receivable-collection-search"/></label><button className="secondary-button" type="submit" data-testid="receivable-collection-search-submit">{common("applySearch")}</button></form>{assignments.pending?<SkeletonBlock rows={2}/>:null}{assignments.error?<ReadError error={assignments.error} retry={assignments.refresh}/>:null}{assignments.data?.source.items.filter(item=>!item.release).length===0?<EmptyState>{t("emptyClaims")}</EmptyState>:null}<label className="field"><span>{t("originalClaim")}</span><select value={selected} onChange={event=>setSelected(event.target.value)} data-testid="receivable-collection-assignment"><option value="">{t("chooseClaim")}</option>{assignments.data?.source.items.filter(item=>!item.release).map(item=><option key={item.id} value={item.id}>{item.purpose} · {money(locale,item.amount)}</option>)}</select></label><div className="app-actions">{after?<button type="button" className="secondary-button" onClick={()=>{setAfter(undefined);setSelected("");}}>{common("firstPage")}</button>:null}{assignments.data?.source.next?<button type="button" className="secondary-button" onClick={()=>{setAfter(assignments.data!.source.next!);setSelected("");}}>{common("nextPage")}</button>:null}</div><ReceiptForm key={selected} id={selected} locale={locale} scope={scope} onChanged={changed}/><CollectionHistory key={`${revision}-${selected}`} locale={locale} scope={scope} onChanged={changed} assignmentId={selected||undefined}/></section>;
}
