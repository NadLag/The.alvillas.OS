"use client";
import Link from "next/link";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {formatDateTime} from "@/i18n/format";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {maintenanceIssueCommandStatusSchema,maintenanceIssueLinkPublishedSchema,type MaintenanceIssueSource} from "../domain/issue-context";
import {maintenanceIssueViewSchema,maintenanceIssueHistorySchema,maintenanceIssueChoicesSchema,maintenanceIssueReviewSchema,maintenanceIssueRecoverySchema,type MaintenanceIssueView} from "../domain/issue-context-view";
import {maintenanceIssueRequest,MaintenanceBrowserError,type MaintenanceBrowserState} from "./issue-browser";
import {WorkOrderManager} from "./work-order-manager";

type Choices=z.infer<typeof maintenanceIssueChoicesSchema>;
type Review=z.infer<typeof maintenanceIssueReviewSchema>;
type History=z.infer<typeof maintenanceIssueHistorySchema>;
type NamedSource={reference:MaintenanceIssueSource;label:string;labels?:Parameters<typeof localizedText>[0]};
const kinds=["PROPERTY","RESERVATION","GUEST","TASK","PERSON","SUPPLIER","EXPENSE","ASSET","PHOTO","DOCUMENT"] as const;

export function MaintenanceIssueManager({locale,authorizationScope:scope,issueId}:{locale:AppLocale;authorizationScope:string;issueId:string}){
 const t=useTranslations("MaintenanceIssues"),operations=useTranslations("Operations.manage"),id=useId();
 const [value,setValue]=useState<MaintenanceIssueView|null>(null),[choices,setChoices]=useState<Choices|null>(null),[review,setReview]=useState<Review|null>(null),[history,setHistory]=useState<History|null>(null);
 const [kind,setKind]=useState<(typeof kinds)[number]>("PROPERTY"),[provider,setProvider]=useState<"DOCUMENT_VERSION"|"FIELD_EVIDENCE">("DOCUMENT_VERSION"),[query,setQuery]=useState(""),[selected,setSelected]=useState<MaintenanceIssueSource|null>(null),[reason,setReason]=useState("");
 const [pendingOperation,setPendingOperation]=useState<"ATTACH"|"DETACH">("ATTACH");
 const [state,setState]=useState<MaintenanceBrowserState>("loading"),[busy,setBusy]=useState(false),[visible,setVisible]=useState(true),[notice,setNotice]=useState<"saved"|"notRecorded"|"unconfirmed"|null>(null);
 const controller=useRef<AbortController|null>(null),epoch=useRef(0),publishing=useRef(false),disclosureStamp=useRef<string|null>(null),nonceKey="alvillas:maintenance-issue:"+scope+":"+issueId;
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const clear=useCallback(()=>{setValue(null);setChoices(null);setReview(null);setHistory(null);setSelected(null);setQuery("");setReason("");setKind("PROPERTY");setProvider("DOCUMENT_VERSION");setPendingOperation("ATTACH");},[]);
 const denied=useCallback(()=>{invalidate();clear();setBusy(false);setNotice(null);setState("forbidden");},[invalidate,clear]);
 const run=useCallback(async<T extends {authorizationStamp:string},>(work:(signal:AbortSignal)=>Promise<T>,apply:(result:T)=>void,refreshRoot=true)=>{
  invalidate();const abort=new AbortController(),own=epoch.current;controller.current=abort;setValue(null);setChoices(null);setHistory(null);setReview(null);setBusy(true);setState("loading");
  try{
   const result=await work(abort.signal);
   const current=refreshRoot?maintenanceIssueViewSchema.parse(await maintenanceIssueRequest("read",{issueId},abort.signal,scope)):null;
   if(current&&(current.issue.id!==issueId||current.authorizationStamp!==result.authorizationStamp))throw new MaintenanceBrowserError("conflict");
   if(!abort.signal.aborted&&own===epoch.current){
    if(disclosureStamp.current&&disclosureStamp.current!==result.authorizationStamp){setSelected(null);setQuery("");setReason("");setKind("PROPERTY");setProvider("DOCUMENT_VERSION");setPendingOperation("ATTACH");}
    disclosureStamp.current=result.authorizationStamp;if(current)setValue(current);apply(result);setState("ready");
   }
  }
  catch(error){if(!abort.signal.aborted&&own===epoch.current){if(error instanceof MaintenanceBrowserError&&error.state==="forbidden")denied();else setState(error instanceof MaintenanceBrowserError?error.state:"validation");}}
  finally{if(own===epoch.current)setBusy(false);}
 },[invalidate,denied,issueId,scope]);
 const load=useCallback(async()=>{
  clear();await run(async signal=>{
   const nonce=readCommandNonce(nonceKey);let saved:"saved"|"notRecorded"|null=null;
   if(nonce){
    try{const recovered=maintenanceIssueRecoverySchema.parse(await maintenanceIssueRequest("recover",{issueId,idempotencyKey:nonce},signal,scope));if(recovered.receipt&&(recovered.receipt.organizationId+"."+recovered.receipt.actorId!==scope||recovered.receipt.idempotencyKey!==nonce||recovered.receipt.intent.issueId!==issueId))throw new MaintenanceBrowserError("forbidden");saved=recovered.recorded?"saved":"notRecorded";}
    catch(original){
     const status=maintenanceIssueCommandStatusSchema.parse(await maintenanceIssueRequest("status",{issueId,idempotencyKey:nonce},signal,scope));
     if(status.organizationId+"."+status.actorId!==scope||status.issueId!==issueId||status.idempotencyKey!==nonce)throw new MaintenanceBrowserError("forbidden");
     if(status.state==="UNKNOWN")throw original;saved=status.state==="RECORDED"?"saved":"notRecorded";
    }
    if(signal.aborted)throw new MaintenanceBrowserError("unavailable");clearCommandNonce(nonceKey,nonce);
   }
   const data=maintenanceIssueViewSchema.parse(await maintenanceIssueRequest("read",{issueId},signal,scope));if(data.issue.id!==issueId)throw new MaintenanceBrowserError("forbidden");return{authorizationStamp:data.authorizationStamp,data,saved};
  },result=>{setValue(result.data);if(result.saved)setNotice(result.saved);},false);
 },[clear,run,nonceKey,issueId,scope]);
 useEffect(()=>{
  let mounted=true;
  const hide=()=>{invalidate();clear();setVisible(false);setBusy(false);setNotice(null);};
  const show=()=>{if(document.hidden)return;setVisible(true);void load();};
  const visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);
  queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else if(!navigator.onLine)offline();else show();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,clear,load]);
 const name=(source:NamedSource)=>source.labels?localizedText(source.labels,locale):source.reference.kind==="TASK"&&operations.has("types."+source.label)?operations("types."+source.label):source.label;
 async function search(cursor?:string){setChoices(null);setSelected(null);setReview(null);setPendingOperation("ATTACH");setReason("");await run<Choices>(async signal=>maintenanceIssueChoicesSchema.parse(await maintenanceIssueRequest("sources",{issueId,kind,...kind==="PHOTO"?{provider}:kind==="DOCUMENT"?{provider:"DOCUMENT_VERSION"}:{},query,...cursor?{cursor}:{}},signal,scope)),setChoices);}
 async function prepare(operation:"ATTACH"|"DETACH",source:MaintenanceIssueSource){
  if(!value||reason.trim().length<6){setState("validation");return;}setReview(null);setHistory(null);
  await run<Review>(async signal=>{const data=maintenanceIssueReviewSchema.parse(await maintenanceIssueRequest("review",{issueId,expectedVersion:value.version,operation,source,reason},signal,scope));if(data.intent.issueId!==issueId||data.intent.expectedVersion!==value.version||data.intent.operation!==operation||JSON.stringify(data.intent.source)!==JSON.stringify(source))throw new MaintenanceBrowserError("forbidden");return data;},setReview);
 }
 async function publish(){
  if(!review||busy||publishing.current)return;publishing.current=true;invalidate();const abort=new AbortController(),own=epoch.current;controller.current=abort;setBusy(true);
  const nonce=crypto.randomUUID();writeCommandNonce(nonceKey,nonce);
  if(readCommandNonce(nonceKey)!==nonce){publishing.current=false;setBusy(false);setState("unavailable");return;}
  try{
   const receipt=maintenanceIssueLinkPublishedSchema.parse(await maintenanceIssueRequest("publish",{intent:review.intent,reviewFingerprint:review.reviewFingerprint,idempotencyKey:nonce},abort.signal,scope));
   if(receipt.organizationId+"."+receipt.actorId!==scope||receipt.idempotencyKey!==nonce||receipt.reviewFingerprint!==review.reviewFingerprint||JSON.stringify(receipt.intent)!==JSON.stringify(review.intent))throw new MaintenanceBrowserError("uncertain");
   clearCommandNonce(nonceKey,nonce);if(!abort.signal.aborted&&own===epoch.current){setNotice("saved");await load();}
  }catch(error){
   if(!abort.signal.aborted&&own===epoch.current){
    if(error instanceof MaintenanceBrowserError&&["validation","conflict","forbidden"].includes(error.state)){clearCommandNonce(nonceKey,nonce);setReview(null);if(error.state==="forbidden")denied();else setState(error.state);}
    else{clear();setNotice("unconfirmed");await load();}
   }
  }finally{publishing.current=false;if(own===epoch.current)setBusy(false);}
 }
 async function historyPage(before?:string){setHistory(null);await run<History>(async signal=>maintenanceIssueHistorySchema.parse(await maintenanceIssueRequest("history",{issueId,...before?{before}:{}},signal,scope)),setHistory);}
 function selectedRecordName(){
  if(!selected)return t("maskedSource");
  const choice=choices?.items.find(source=>JSON.stringify(source.reference)===JSON.stringify(selected));
  const linked=value?.sources.find(source=>source.state==="VISIBLE"&&JSON.stringify(source.reference)===JSON.stringify(selected));
  return choice?name(choice):linked?.state==="VISIBLE"?name(linked):t("maskedSource");
 }
 const media=(navigation:NonNullable<Choices["items"][number]["navigation"]>)=>navigation.kind==="FIELD_EVIDENCE"?"/api/operations/evidence/"+navigation.id:"/"+locale+"/app/documents?document="+navigation.documentId+"&version="+navigation.version;
 if(!visible)return <div className="resource-form" data-testid="maintenance-issue-manager"><p role="status">{t(state==="offline"?"states.offline":"privateHidden")}</p></div>;
 return <div className="resource-form" data-testid="maintenance-issue-manager">
  <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>void load()}>{t("refresh")}</button>{value?<Link prefetch={false} className="secondary-button" href={"/"+locale+"/app/operations/"+value.issue.taskId}>{t("originalTask")}</Link>:null}</div>
  {notice?<p role="status">{t(notice)}</p>:null}
  {state==="loading"?<SkeletonBlock rows={4}/>:null}
  {value?<>
   <section className="detail-panel resource-form" data-testid="maintenance-issue-detail"><h2 dir="auto">{value.issue.title}</h2><p dir="auto">{value.issue.description}</p><p>{operations("priorities."+value.issue.severity)} · {t.has("issueStates."+value.issue.state)?t("issueStates."+value.issue.state):value.issue.state}</p><p>{t("version",{number:new Intl.NumberFormat(locale).format(BigInt(value.version))})}</p>{value.issue.evidenceId?<a href={"/api/operations/evidence/"+value.issue.evidenceId} target="_blank" rel="noopener noreferrer">{t("openEvidence")}</a>:null}</section>
   <section className="resource-form" data-testid="maintenance-issue-sources"><h2>{t("linkedRecords")}</h2>
    {!value.sources.length?<p>{t("emptySources")}</p>:<ul className="resource-list">{value.sources.map(source=><li key={source.contextId} className="detail-panel resource-form">
     <strong>{t("kinds."+(source.state==="VISIBLE"?source.reference.kind:source.kind))}</strong>
     {source.state==="VISIBLE"?<><p dir="auto">{name(source)}</p>{source.navigation?<a href={media(source.navigation)} target="_blank" rel="noopener noreferrer">{t("openEvidence")}</a>:null}{value.capabilities.edit?<button type="button" className="quiet-button" disabled={busy} onClick={()=>{setSelected(source.reference);setPendingOperation("DETACH");setReason("");setReview(null);document.getElementById(id+"reason")?.focus();}}>{t("unlink")}</button>:null}</>:<p>{t("maskedSource")}</p>}
    </li>)}</ul>}
   </section>
   {value.capabilities.edit?<section className="resource-form" data-testid="maintenance-issue-link-editor"><h2>{t(pendingOperation==="DETACH"?"unlinkRecord":"addRecord")}</h2>
    <fieldset className="resource-form" disabled={busy}>
     <legend>{t("changeRecord")}</legend>
     <form className="resource-form" onSubmit={(event:FormEvent)=>{event.preventDefault();void search();}}>
      <label className="field" htmlFor={id+"kind"}><span>{t("recordType")}</span><select id={id+"kind"} value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setChoices(null);setSelected(null);setReview(null);setQuery("");setReason("");setPendingOperation("ATTACH");}}>{kinds.map(kind=><option key={kind} value={kind}>{t("kinds."+kind)}</option>)}</select></label>
      {kind==="PHOTO"?<label className="field" htmlFor={id+"provider"}><span>{t("photoLocation")}</span><select id={id+"provider"} value={provider} onChange={event=>{setProvider(event.target.value as typeof provider);setChoices(null);setSelected(null);setReview(null);setReason("");setPendingOperation("ATTACH");}}><option value="DOCUMENT_VERSION">{t("documentArchive")}</option><option value="FIELD_EVIDENCE">{t("taskPhotos")}</option></select></label>:null}
      <label className="field" htmlFor={id+"query"}><span>{t("searchLabel")}</span><input id={id+"query"} type="search" maxLength={120} value={query} onChange={event=>{setQuery(event.target.value);setReview(null);setSelected(null);}}/></label>
      <button type="submit" className="secondary-button">{t("search")}</button>
     </form>
     {choices?<div className="maintenance-issue-choices" data-testid="maintenance-issue-choices">{!choices.ready?<p role="status">{t("sourceUnavailable")}</p>:!choices.items.length?<p>{t("emptyChoices")}</p>:<ul className="resource-list">{choices.items.map(source=><li key={source.reference.kind+":"+source.reference.id}><button type="button" className="secondary-button" onClick={()=>{setSelected(source.reference);setPendingOperation("ATTACH");setReason("");setReview(null);}}><span dir="auto">{name(source)}</span></button></li>)}</ul>}<div className="form-actions">{choices.next?<button type="button" className="secondary-button" onClick={()=>void search(choices.next!)}>{t("next")}</button>:null}<button type="button" className="quiet-button" onClick={()=>void search()}>{t("first")}</button></div></div>:null}
     {selected?<p role="status">{t("selectedRecord")}: <span dir="auto">{selectedRecordName()}</span></p>:null}
     <label className="field" htmlFor={id+"reason"}><span>{t("reason")}</span><textarea id={id+"reason"} minLength={6} maxLength={500} value={reason} onChange={event=>{setReason(event.target.value);setReview(null);}}/></label>
     <p>{t("unlinkHelp")}</p>
     <button type="button" className="primary-button" disabled={!selected} onClick={()=>{if(selected)void prepare(pendingOperation,selected);}}>{t(pendingOperation==="DETACH"?"reviewUnlink":"review")}</button>
    </fieldset>
   </section>:null}
   {review?<section className="detail-panel resource-form" data-testid="maintenance-issue-review"><h2>{t("reviewTitle")}</h2><p>{t("operations."+review.intent.operation)} · {t("kinds."+review.intent.source.kind)}</p><p dir="auto">{name(review.source)}</p><p dir="auto">{review.intent.reason}</p><p>{t("historyPreserved")}</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void publish()}>{t(busy?"saving":"publish")}</button><button type="button" className="quiet-button" disabled={busy} onClick={()=>setReview(null)}>{t("changeReview")}</button></section>:null}
   <section className="resource-form"><h2>{t("history")}</h2><button type="button" className="secondary-button" disabled={busy} onClick={()=>void historyPage()}>{t("showHistory")}</button>{history?<div data-testid="maintenance-issue-history">{!history.items.length?<p>{t("emptyHistory")}</p>:<ol className="resource-list">{history.items.map(row=><li key={row.id}><strong>{t("operations."+row.operation)} · {t("kinds."+row.kind)}</strong><p>{formatDateTime(locale,new Date(row.createdAt),{timeZone:"UTC"})} · {t(row.actor==="SELF"?"you":"anotherActor")}</p>{row.detail?<><p dir="auto">{name(row.detail)}</p><p dir="auto">{row.detail.reason}</p>{row.detail.navigation?<a href={media(row.detail.navigation)} target="_blank" rel="noopener noreferrer">{t("openEvidence")}</a>:null}</>:<p>{t("maskedSource")}</p>}</li>)}</ol>}<div className="form-actions">{history.next?<button type="button" className="secondary-button" disabled={busy} onClick={()=>void historyPage(history.next!)}>{t("next")}</button>:null}<button type="button" className="quiet-button" disabled={busy} onClick={()=>void historyPage()}>{t("first")}</button></div></div>:null}</section>
   <WorkOrderManager key={scope+":"+issueId+":"+value.authorizationStamp} locale={locale} scope={scope} issueId={issueId} authorizationStamp={value.authorizationStamp} onRevalidate={load}/>
  </>:null}
  {state!=="ready"&&state!=="loading"?<p role="alert">{t("states."+state)}</p>:null}
 </div>;
}
