"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {SkeletonBlock,StatusBadge} from "@/design-system/shells";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {guestHubIdentityCaptureViewSchema,guestHubIdentityCaptureReviewSchema,guestHubIdentityCaptureReceiptSchema,guestHubIdentityCaptureRecoverySchema} from "../domain/guest-hub-identity-capture-read-model";
import {guestHubIdentityFileStatusSchema} from "../domain/guest-hub-identity-file-read-model";
import {guestHubRequest,GuestHubBrowserError,type GuestHubBrowserState} from "./guest-hub-browser";
import {prepareGuestHubIdentityFile,uploadGuestHubIdentityFile} from "./guest-hub-identity-files";

type View=z.infer<typeof guestHubIdentityCaptureViewSchema>;
type Capture=NonNullable<View["originalCapture"]>;
type Status=z.infer<typeof guestHubIdentityFileStatusSchema>;
type Review={value:z.infer<typeof guestHubIdentityCaptureReviewSchema>;files:Readonly<Record<string,File>>};
class IdentityNonceStorageError extends Error{}
const slot=(item:{kind:string;part:string})=>item.kind+":"+item.part;

/** Private file handles and descriptors live only in this mounted form. Recovery
 * retains an opaque command UUID; publication is shown only from native receipts. */
export function GuestHubIdentityDocumentsForm({locale,linkId,onClose}:{locale:AppLocale;linkId:string;onClose:()=>void}){
 const t=useTranslations("GuestIdentityDocuments"),[view,setView]=useState<View|null>(null),[capture,setCapture]=useState<Capture|null>(null),[statuses,setStatuses]=useState<Status[]>([]),[files,setFiles]=useState<Record<string,File>>({}),[review,setReview]=useState<Review|null>(null),[acknowledged,setAcknowledged]=useState(false),[replacement,setReplacement]=useState(false),[state,setState]=useState<GuestHubBrowserState|"storage_unavailable">("loading"),[busy,setBusy]=useState(true),[pending,setPending]=useState(false),[unrecorded,setUnrecorded]=useState(false),[notice,setNotice]=useState<"saved"|"recovered"|"replaced"|null>(null),[inputEpoch,setInputEpoch]=useState(0);
 const controller=useRef<AbortController|null>(null),epoch=useRef(0),busyRef=useRef(false),nonce=useRef<string|null>(null),key="alvillas:guest-identity-capture:"+linkId,path="links/"+linkId+"/identity-documents/";
 const active=useCallback((own:number)=>own===epoch.current&&!controller.current?.signal.aborted,[]);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;busyRef.current=false;},[]);
 const clearFiles=useCallback(()=>{setFiles({});setReview(null);setAcknowledged(false);setInputEpoch(value=>value+1);},[]);
 const clearPrivate=useCallback(()=>{clearFiles();setView(null);setCapture(null);setStatuses([]);setReplacement(false);setNotice(null);},[clearFiles]);
 const forgetNonce=useCallback(()=>{if(nonce.current)clearCommandNonce(key,nonce.current);nonce.current=null;setPending(false);setUnrecorded(false);},[key]);
 const captureStatuses=useCallback(async(value:Capture,signal:AbortSignal)=>Promise.all(value.files.map(async item=>{
  const result=guestHubIdentityFileStatusSchema.parse(await guestHubRequest(path+value.id+"/files/"+item.id+"/status",{},signal));if(result.captureId!==value.id||result.fileId!==item.id||result.kind!==item.kind||result.part!==item.part)throw new GuestHubBrowserError("uncertain");return result;
 })),[path]);
 const load=useCallback(async(signal:AbortSignal,own:number)=>{
  const original=nonce.current??readCommandNonce(key);let recovered:Capture|null=null,previousStatuses:Status[]|undefined;
  if(original){nonce.current=original;setPending(true);const result=guestHubIdentityCaptureRecoverySchema.parse(await guestHubRequest(path+"recover",{idempotencyKey:original},signal));if(result.linkId!==linkId||result.idempotencyKey!==original)throw new GuestHubBrowserError("uncertain");setUnrecorded(!result.recorded);if(result.recorded)recovered={id:result.id,files:result.files};}
  const current=guestHubIdentityCaptureViewSchema.parse(await guestHubRequest(path+"view",{},signal));if(current.linkId!==linkId)throw new GuestHubBrowserError("link_unavailable");
  if(recovered){previousStatuses=await captureStatuses(recovered,signal);if(!active(own))return;if(previousStatuses.every(item=>item.state==="PUBLISHED")){forgetNonce();setNotice("recovered");}else if(previousStatuses.every(item=>!item.currentCapture)){forgetNonce();setNotice("replaced");recovered=null;}}
  const selected=current.originalCapture??recovered,metadata=selected?selected.id===recovered?.id&&previousStatuses?previousStatuses:await captureStatuses(selected,signal):[];if(!active(own))return;
  if(selected&&metadata.every(item=>item.state==="PUBLISHED")&&(!original||recovered?.id===selected.id))forgetNonce();setView(current);setCapture(selected??null);setStatuses(metadata);setReplacement(false);setState("ready");
 },[active,captureStatuses,forgetNonce,key,linkId,path]);
 const perform=useCallback(async(work:(signal:AbortSignal,own:number)=>Promise<void>)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setState("loading");controller.current?.abort();const selected=new AbortController();controller.current=selected;const own=++epoch.current;
  try{await work(selected.signal,own);}catch(error){if(active(own)){clearPrivate();setState(error instanceof IdentityNonceStorageError?"storage_unavailable":error instanceof GuestHubBrowserError?error.state:"unavailable");}}finally{if(active(own)){busyRef.current=false;setBusy(false);}}
 },[active,clearPrivate]);
 const refresh=useCallback(()=>{clearPrivate();void perform(load);},[clearPrivate,perform,load]);
 useEffect(()=>{
  void perform(load);const focus=()=>{if(document.visibilityState==="visible"&&!busyRef.current)refresh();},hidden=()=>{if(document.visibilityState==="hidden"){invalidate();clearPrivate();setBusy(false);setState("loading");}else focus();},offline=()=>{invalidate();clearPrivate();setBusy(false);setState("offline");};
  window.addEventListener("focus",focus);window.addEventListener("online",focus);window.addEventListener("offline",offline);document.addEventListener("visibilitychange",hidden);
  return()=>{invalidate();window.removeEventListener("focus",focus);window.removeEventListener("online",focus);window.removeEventListener("offline",offline);document.removeEventListener("visibilitychange",hidden);};
 },[perform,load,refresh,invalidate,clearPrivate]);
 const requestReview=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!view||busyRef.current)return;const current=view,selected={...files},idempotencyKey=nonce.current??crypto.randomUUID();setNotice(null);void perform(async(signal,own)=>{
  const descriptors=[];for(const kind of current.documentKinds){const chosen=kind.allowedParts.filter(part=>selected[slot({kind:kind.kind,part})]);if(current.requiredKinds.includes(kind.kind)&&!chosen.length||chosen.length&&kind.requiredParts.some(part=>!chosen.includes(part)))throw new GuestHubBrowserError("validation");for(const part of chosen)descriptors.push(await prepareGuestHubIdentityFile(selected[slot({kind:kind.kind,part})],kind.kind,part,kind,signal));}
  if(!descriptors.length)throw new GuestHubBrowserError("validation");const value=guestHubIdentityCaptureReviewSchema.parse(await guestHubRequest(path+"review",{previousCaptureId:current.previousCaptureId,idempotencyKey,files:descriptors,acknowledged},signal));if(value.idempotencyKey!==idempotencyKey||value.grantId!==current.grantId)throw new GuestHubBrowserError("uncertain");if(active(own)){setReview({value,files:selected});setState("ready");}
 });};
 const sendFiles=async(selected:Capture,originals:Readonly<Record<string,File>>,signal:AbortSignal,own:number,initial:Status[]=[])=>{
  const complete=new Map(initial.map(item=>[item.fileId,item]));for(const item of selected.files){if(complete.get(item.id)?.state==="PUBLISHED")continue;const file=originals[slot(item)];if(!file)throw new GuestHubBrowserError("validation");const result=await uploadGuestHubIdentityFile(linkId,selected.id,item,file,signal);if(result.state!=="PUBLISHED")throw new GuestHubBrowserError("uncertain");complete.set(item.id,result);if(active(own))setStatuses([...complete.values()]);}
  if(!active(own))return;forgetNonce();clearFiles();setNotice("saved");setState("ready");
 };
 const confirm=()=>{if(!review||!view||busyRef.current)return;const checked=review,current=view;void perform(async(signal,own)=>{
  if(nonce.current&&nonce.current!==checked.value.idempotencyKey)throw new GuestHubBrowserError("uncertain");writeCommandNonce(key,checked.value.idempotencyKey);if(readCommandNonce(key)!==checked.value.idempotencyKey)throw new IdentityNonceStorageError();nonce.current=checked.value.idempotencyKey;setPending(true);clearFiles();
  const saved=guestHubIdentityCaptureReceiptSchema.parse(await guestHubRequest(path+"admit",{previousCaptureId:checked.value.previousCaptureId,idempotencyKey:checked.value.idempotencyKey,files:checked.value.files,acknowledged:checked.value.acknowledged,reviewFingerprint:checked.value.reviewFingerprint},signal));if(saved.linkId!==linkId||saved.idempotencyKey!==nonce.current||saved.grantId!==current.grantId)throw new GuestHubBrowserError("uncertain");if(!active(own))return;const selected={id:saved.id,files:saved.files};setCapture(selected);setStatuses([]);setUnrecorded(false);setReplacement(false);setView({...current,previousCaptureId:saved.id,captureCount:saved.version,originalCapture:selected});await sendFiles(selected,checked.files,signal,own);
 });};
 const resume=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!capture||!view||busyRef.current)return;const selected=capture,originals={...files},known=[...statuses];void perform(async(signal,own)=>{
  for(const item of selected.files){if(known.some(status=>status.fileId===item.id&&status.state==="PUBLISHED"))continue;const file=originals[slot(item)],policy=view.documentKinds.find(kind=>kind.kind===item.kind);if(!file||!policy||file.size<1||file.size>policy.maxBytes||!policy.contentTypes.includes(file.type as typeof policy.contentTypes[number]))throw new GuestHubBrowserError("validation");}await sendFiles(selected,originals,signal,own,known);
 });};
 const published=statuses.filter(item=>item.state==="PUBLISHED").length,allPublished=Boolean(capture&&published===capture.files.length),locked=busy||state==="offline",close=()=>{invalidate();clearPrivate();onClose();};
 const fileInput=(kind:View["documentKinds"][number],part:View["documentKinds"][number]["allowedParts"][number],required:boolean)=>{const id=slot({kind:kind.kind,part});return <label key={inputEpoch+":"+id} className="field"><span>{t("kinds."+kind.kind)} · {t("parts."+part)}{required?" *":""}</span><input type="file" accept={kind.contentTypes.join(",")} required={required} disabled={locked} onChange={event=>{const selected=event.currentTarget.files?.[0];setFiles(current=>{const next={...current};if(selected)next[id]=selected;else delete next[id];return next;});setReview(null);}} data-testid={"guest-identity-file-"+kind.kind+"-"+part}/><span>{t("limit",{size:new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(kind.maxBytes/1048576)})}</span></label>;};
 return <section className="resource-form guest-profile-form" data-testid="guest-identity-form" aria-busy={busy}>
  <h3>{t("title")}</h3><div aria-live="polite" data-testid="guest-identity-status"><p role={state==="ready"||state==="loading"?"status":"alert"}>{state==="ready"?t("loaded"):state==="loading"?t("loading"):state==="storage_unavailable"?t("storageUnavailable"):t("states."+state)}</p>{notice&&<p role="status">{t(notice)}</p>}</div>{busy&&<SkeletonBlock rows={2}/>}
  {pending&&<p data-testid="guest-identity-pending">{t("uncertain")}</p>}
  {view&&<section className="resource-form"><h4 dir="auto">{localizedText(view.notice.title,locale)}</h4>{view.notice.paragraphs.map((paragraph,index)=><p key={index} dir="auto">{localizedText(paragraph,locale)}</p>)}<p>{t("privacy")}</p></section>}
  {view&&capture&&!replacement&&<section className="resource-form" data-testid="guest-identity-original"><p role="status">{t("progress",{completed:published,total:capture.files.length})}</p><ul>{capture.files.map(item=><li key={item.id}>{t("kinds."+item.kind)} · {t("parts."+item.part)} <StatusBadge tone={statuses.some(status=>status.fileId===item.id&&status.state==="PUBLISHED")?"success":"warning"}>{t(statuses.some(status=>status.fileId===item.id&&status.state==="PUBLISHED")?"published":"awaiting")}</StatusBadge></li>)}</ul>
   {!allPublished&&<form className="resource-form" onSubmit={resume} data-testid="guest-identity-resume"><p>{t("reselect")}</p>{capture.files.filter(item=>!statuses.some(status=>status.fileId===item.id&&status.state==="PUBLISHED")).map(item=>{const kind=view.documentKinds.find(kind=>kind.kind===item.kind);return kind?fileInput(kind,item.part,true):null;})}<button type="submit" className="primary-button" disabled={locked}>{t("resume")}</button></form>}
   {view.captureCount<view.maxCaptures&&<button type="button" className="secondary-button" onClick={()=>{if(!unrecorded)forgetNonce();clearFiles();setReplacement(true);setNotice(null);}} disabled={locked} data-testid="guest-identity-replace">{t("replace")}</button>}
  </section>}
  {view&&(!capture||replacement)&&!review&&<form className="resource-form" onSubmit={requestReview} autoComplete="off" data-testid="guest-identity-inputs"><p>{t("choose")}</p>{view.documentKinds.map(kind=><div className="resource-form" key={kind.kind}>{kind.allowedParts.map(part=>fileInput(kind,part,view.requiredKinds.includes(kind.kind)&&kind.requiredParts.includes(part)))}</div>)}{view.requireAcknowledgement&&<label className="field"><span><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} required disabled={locked} data-testid="guest-identity-acknowledge"/> {t("acknowledge")}</span></label>}<button type="submit" className="primary-button" disabled={locked||view.captureCount>=view.maxCaptures} data-testid="guest-identity-review">{t("review")}</button>{view.captureCount>=view.maxCaptures&&<p role="status">{t("limitReached")}</p>}</form>}
  {review&&<section className="resource-form" data-testid="guest-identity-review-record"><h4>{t("reviewTitle")}</h4><p>{t("reviewGuidance")}</p><ul>{review.value.files.map(item=><li key={slot(item)}>{t("kinds."+item.kind)} · {t("parts."+item.part)}</li>)}</ul><div className="form-actions"><button type="button" className="primary-button" onClick={confirm} disabled={locked} data-testid="guest-identity-confirm">{t("confirm")}</button><button type="button" className="secondary-button" onClick={()=>setReview(null)} disabled={busy}>{t("edit")}</button></div></section>}
  <div className="form-actions"><button type="button" className="secondary-button" onClick={refresh} disabled={busy} data-testid="guest-identity-refresh">{t("refresh")}</button><button type="button" className="secondary-button" onClick={close}>{t("close")}</button></div>
 </section>;
}
