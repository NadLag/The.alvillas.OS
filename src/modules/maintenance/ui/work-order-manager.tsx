"use client";
import Link from "next/link";
import { WorkOrderAssetPanel } from "./work-order-asset-panel";
import { ContractorAssignmentPanel } from "./contractor-assignment-panel";
import { WorkOrderFinancePanel } from "./work-order-finance-panel";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {formatDateTime} from "@/i18n/format";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {workOrderListSchema,workOrderTaskChoicesSchema,workOrderRegistrationReviewSchema,workOrderRegistrationPublishedSchema,workOrderRegistrationRecoverySchema,workOrderCommandStatusSchema} from "../domain/work-order";
import {maintenanceWorkOrderRequest,MaintenanceBrowserError,type MaintenanceBrowserState} from "./issue-browser";

type List=z.infer<typeof workOrderListSchema>;
type Choices=z.infer<typeof workOrderTaskChoicesSchema>;
type Review=z.infer<typeof workOrderRegistrationReviewSchema>;

/** Mounted only inside a current operational issue view. The parent clears
 * this whole private workspace on offline, inactivity or scope revalidation. */
export function WorkOrderManager({locale,scope,issueId,authorizationStamp,onRevalidate}:{locale:AppLocale;scope:string;issueId:string;authorizationStamp:string;onRevalidate:()=>Promise<void>}){
 const t=useTranslations("MaintenanceIssues"),operations=useTranslations("Operations.manage"),id=useId(),nonceKey="alvillas:maintenance-work-order:"+scope+":"+issueId;
 const [value,setValue]=useState<List|null>(null),[choices,setChoices]=useState<Choices|null>(null),[review,setReview]=useState<Review|null>(null),[selected,setSelected]=useState<Choices["items"][number]|null>(null),[query,setQuery]=useState(""),[reason,setReason]=useState("");
 const [busy,setBusy]=useState(false),[state,setState]=useState<MaintenanceBrowserState>("loading"),[notice,setNotice]=useState<"saved"|"notRecorded"|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0),publishing=useRef(false);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const clear=useCallback(()=>{setValue(null);setChoices(null);setReview(null);setSelected(null);setQuery("");setReason("");},[]);
 const run=useCallback(async<T extends {authorizationStamp:string},>(work:(signal:AbortSignal)=>Promise<T>,apply:(result:T)=>void,refresh=true)=>{
  invalidate();const abort=new AbortController(),own=epoch.current;controller.current=abort;setValue(null);setChoices(null);setReview(null);setState("loading");setBusy(true);
  try{
   const result=await work(abort.signal),root=refresh?workOrderListSchema.parse(await maintenanceWorkOrderRequest("read",{issueId},abort.signal,scope)):null;
   if(result.authorizationStamp!==authorizationStamp||root&&root.authorizationStamp!==authorizationStamp)throw new MaintenanceBrowserError("conflict");
   if(!abort.signal.aborted&&own===epoch.current){if(root)setValue(root);apply(result);setState("ready");}
  }catch(error){if(!abort.signal.aborted&&own===epoch.current){clear();const failure=error instanceof MaintenanceBrowserError?error.state:"validation";setState(failure);if(failure==="forbidden"||failure==="conflict")void onRevalidate();}}
  finally{if(own===epoch.current)setBusy(false);}
 },[invalidate,clear,authorizationStamp,issueId,scope,onRevalidate]);
 const load=useCallback(async(cursor?:string)=>{
  clear();await run(async signal=>{
   const nonce=readCommandNonce(nonceKey);let saved:"saved"|"notRecorded"|null=null;
   if(nonce){
    try{const result=workOrderRegistrationRecoverySchema.parse(await maintenanceWorkOrderRequest("recover",{issueId,idempotencyKey:nonce},signal,scope));if(result.recorded&&(result.receipt.organizationId+"."+result.receipt.actorId!==scope||result.receipt.intent.issueId!==issueId||result.receipt.idempotencyKey!==nonce))throw new MaintenanceBrowserError("forbidden");saved=result.recorded?"saved":"notRecorded";}
    catch(original){const result=workOrderCommandStatusSchema.parse(await maintenanceWorkOrderRequest("status",{issueId,idempotencyKey:nonce},signal,scope));if(result.organizationId+"."+result.actorId!==scope||result.issueId!==issueId||result.idempotencyKey!==nonce)throw new MaintenanceBrowserError("forbidden");if(result.state==="UNKNOWN")throw original;saved=result.state==="RECORDED"?"saved":"notRecorded";}
    if(signal.aborted)throw new MaintenanceBrowserError("unavailable");clearCommandNonce(nonceKey,nonce);
   }
   const data=workOrderListSchema.parse(await maintenanceWorkOrderRequest("read",{issueId,...cursor?{cursor}:{}},signal,scope));return{authorizationStamp:data.authorizationStamp,data,saved};
  },result=>{setValue(result.data);if(result.saved)setNotice(result.saved);},false);
 },[clear,run,nonceKey,issueId,scope]);
 useEffect(()=>{let mounted=true;queueMicrotask(()=>{if(mounted)void load();});return()=>{mounted=false;invalidate();};},[load,invalidate]);
 async function search(cursor?:string){setSelected(null);setReason("");setNotice(null);await run<Choices>(async signal=>workOrderTaskChoicesSchema.parse(await maintenanceWorkOrderRequest("tasks",{issueId,query,...cursor?{cursor}:{}},signal,scope)),setChoices);}
 async function prepare(){if(!selected||reason.trim().length<6){setState("validation");return;}const intent={issueId,taskId:selected.id,reason};await run<Review>(async signal=>{const result=workOrderRegistrationReviewSchema.parse(await maintenanceWorkOrderRequest("review",intent,signal,scope));if(result.intent.issueId!==issueId||result.intent.taskId!==selected.id||result.issue.id!==issueId)throw new MaintenanceBrowserError("forbidden");return result;},setReview);}
 async function publish(){
  if(!review||busy||publishing.current)return;publishing.current=true;invalidate();const abort=new AbortController(),own=epoch.current;controller.current=abort;setBusy(true);const nonce=crypto.randomUUID();writeCommandNonce(nonceKey,nonce);
  if(readCommandNonce(nonceKey)!==nonce){publishing.current=false;setBusy(false);setState("unavailable");return;}
  try{
   const receipt=workOrderRegistrationPublishedSchema.parse(await maintenanceWorkOrderRequest("publish",{intent:review.intent,reviewFingerprint:review.reviewFingerprint,idempotencyKey:nonce},abort.signal,scope));
   if(receipt.organizationId+"."+receipt.actorId!==scope||receipt.idempotencyKey!==nonce||receipt.reviewFingerprint!==review.reviewFingerprint||JSON.stringify(receipt.intent)!==JSON.stringify(review.intent))throw new MaintenanceBrowserError("uncertain");
   clearCommandNonce(nonceKey,nonce);if(!abort.signal.aborted&&own===epoch.current){setNotice("saved");await load();}
  }catch(error){if(!abort.signal.aborted&&own===epoch.current){if(error instanceof MaintenanceBrowserError&&["validation","conflict","forbidden"].includes(error.state)){clearCommandNonce(nonceKey,nonce);clear();setState(error.state);if(error.state==="conflict"||error.state==="forbidden")void onRevalidate();}else{clear();await load();}}}
  finally{publishing.current=false;if(own===epoch.current)setBusy(false);}
 }
 return <section className="detail-panel resource-form" data-testid="maintenance-work-orders">
  <h2>{t("workOrders.title")}</h2><p>{t("workOrders.description")}</p><button type="button" className="secondary-button" disabled={busy} onClick={()=>void load()}>{t("workOrders.refresh")}</button>
  {notice?<p role="status">{t(notice)}</p>:null}{state==="loading"?<SkeletonBlock rows={3}/>:null}
  {value?<>
   <div data-testid="maintenance-work-order-list">{value.items.length?<ul className="resource-list">{value.items.map((row,index)=><li key={row.state==="VISIBLE"?row.task.id:"masked:"+index} className="resource-form">{row.state==="VISIBLE"?<><h3 dir="auto">{localizedText(row.task.title,locale)}</h3><p>{operations("priorities."+row.task.priority)} · {operations("states."+row.task.state)}</p><p>{t("workOrders.registered",{date:formatDateTime(locale,new Date(row.registeredAt),{timeZone:"UTC"})})}</p><Link prefetch={false} className="secondary-button" href={"/"+locale+"/app/operations/"+row.task.id}>{t("workOrders.manage")}</Link><WorkOrderFinancePanel taskId={row.task.id} locale={locale} scope={scope} authorizationStamp={authorizationStamp}/><ContractorAssignmentPanel taskId={row.task.id} locale={locale} scope={scope} authorizationStamp={authorizationStamp}/><WorkOrderAssetPanel taskId={row.task.id} issueId={issueId} locale={locale} scope={scope} authorizationStamp={authorizationStamp}/></>:<p>{t("maskedSource")}</p>}</li>)}</ul>:<p>{t("workOrders.empty")}</p>}<div className="form-actions">{value.next?<button type="button" className="secondary-button" disabled={busy} onClick={()=>void load(value.next!)}>{t("next")}</button>:null}<button type="button" className="quiet-button" disabled={busy} onClick={()=>void load()}>{t("first")}</button></div></div>
   {value.canRegister?<fieldset className="resource-form maintenance-work-order-editor" disabled={busy} data-testid="maintenance-work-order-editor"><legend>{t("workOrders.add")}</legend>
    <p>{t("workOrders.taskHelp")}</p><Link prefetch={false} className="secondary-button" href={"/"+locale+"/app/operations?propertyId="+value.propertyId}>{t("workOrders.operations")}</Link>
    <form className="resource-form" onSubmit={(event:FormEvent)=>{event.preventDefault();void search();}}><label className="field" htmlFor={id+"query"}><span>{t("workOrders.searchLabel")}</span><input id={id+"query"} type="search" maxLength={120} value={query} onChange={event=>{setQuery(event.target.value);setSelected(null);setReview(null);}}/></label><button type="submit" className="secondary-button">{t("search")}</button></form>
    {choices?<div className="maintenance-work-order-choices" data-testid="maintenance-work-order-choices">{choices.items.length?<ul className="resource-list">{choices.items.map(task=><li key={task.id}><button type="button" className="secondary-button" onClick={()=>{setSelected(task);setReason("");setReview(null);}}><span dir="auto">{localizedText(task.title,locale)}</span></button></li>)}</ul>:<p>{t("emptyChoices")}</p>}<div className="form-actions">{choices.next?<button type="button" className="secondary-button" onClick={()=>void search(choices.next!)}>{t("next")}</button>:null}<button type="button" className="quiet-button" onClick={()=>void search()}>{t("first")}</button></div></div>:null}
    {selected?<p role="status" dir="auto">{localizedText(selected.title,locale)}</p>:null}
    <label className="field" htmlFor={id+"reason"}><span>{t("reason")}</span><textarea id={id+"reason"} minLength={6} maxLength={1000} value={reason} onChange={event=>{setReason(event.target.value);setReview(null);}}/></label><button type="button" className="primary-button" disabled={!selected} onClick={()=>void prepare()}>{t("review")}</button>
   </fieldset>:null}
   {review?<div className="detail-panel resource-form" data-testid="maintenance-work-order-review"><h3>{t("reviewTitle")}</h3><p dir="auto">{review.issue.title}</p><p dir="auto">{localizedText(review.task.title,locale)}</p><p>{operations("priorities."+review.task.priority)} · {operations("states."+review.task.state)}</p><p dir="auto">{review.intent.reason}</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void publish()}>{t(busy?"saving":"workOrders.register")}</button><button type="button" className="quiet-button" disabled={busy} onClick={()=>setReview(null)}>{t("changeReview")}</button></div>:null}
  </>:null}
  {state!=="ready"&&state!=="loading"?<p role="alert">{t("states."+state)}</p>:null}
 </section>;
}
