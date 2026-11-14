"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {guestHubProfileViewSchema,guestHubProfileReviewSchema,guestHubProfileReceiptSchema,guestHubProfileRecoveryResultSchema} from "../domain/guest-hub-profile-contract";
import {guestHubProfileValuesSchema,type GuestHubProfileValues} from "../domain/guest-hub-profile-policy";
import {guestHubRequest,GuestHubBrowserError,type GuestHubBrowserState} from "./guest-hub-browser";

type View=z.infer<typeof guestHubProfileViewSchema>;
type Review=z.infer<typeof guestHubProfileReviewSchema>;
class ProfileNonceStorageError extends Error{}
export function GuestHubProfileForm({locale,linkId,onClose}:{locale:AppLocale;linkId:string;onClose:()=>void}){
 const t=useTranslations("GuestProfile"),access=useTranslations("GuestAccess"),[view,setView]=useState<View|null>(null),[values,setValues]=useState<GuestHubProfileValues>({}),[acknowledged,setAcknowledged]=useState(false),[review,setReview]=useState<Review|null>(null),[state,setState]=useState<GuestHubBrowserState|"storage_unavailable">("loading"),[busy,setBusy]=useState(true),[pending,setPending]=useState(false),[unrecorded,setUnrecorded]=useState(false),[notice,setNotice]=useState<"saved"|"recovered"|null>(null);
 const controller=useRef<AbortController|null>(null),epoch=useRef(0),busyRef=useRef(false),nonce=useRef<string|null>(null),key="alvillas:guest-profile:"+linkId,path="links/"+linkId+"/profile/";
 const active=useCallback((own:number)=>own===epoch.current&&!controller.current?.signal.aborted,[]);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;busyRef.current=false;},[]);
 const clearPrivate=useCallback(()=>{setView(null);setValues({});setReview(null);setAcknowledged(false);},[]);
 const load=useCallback(async(signal:AbortSignal,own:number)=>{
  const original=nonce.current??readCommandNonce(key);if(original){nonce.current=original;setPending(true);const recovered=guestHubProfileRecoveryResultSchema.parse(await guestHubRequest(path+"recover",{idempotencyKey:original},signal));if(recovered.linkId!==linkId||recovered.idempotencyKey!==original)throw new GuestHubBrowserError("uncertain");if(!active(own))return;if(recovered.recorded){clearCommandNonce(key,original);nonce.current=null;setPending(false);setUnrecorded(false);setNotice("recovered");}else setUnrecorded(true);}
  const data=guestHubProfileViewSchema.parse(await guestHubRequest(path+"view",{},signal));if(data.linkId!==linkId)throw new GuestHubBrowserError("link_unavailable");if(active(own)){setView(data);setValues(data.values);setAcknowledged(false);setState("ready");}
 },[key,path,linkId,active]);
 const perform=useCallback(async(work:(signal:AbortSignal,own:number)=>Promise<void>)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setState("loading");controller.current?.abort();const selected=new AbortController();controller.current=selected;const own=++epoch.current;
  try{await work(selected.signal,own);}catch(error){if(active(own)){clearPrivate();setState(error instanceof ProfileNonceStorageError?"storage_unavailable":error instanceof GuestHubBrowserError?error.state:"unavailable");}}
  finally{if(active(own)){busyRef.current=false;setBusy(false);}}
 },[active,clearPrivate]);
 const refresh=useCallback(()=>{clearPrivate();void perform(load);},[clearPrivate,perform,load]);
 useEffect(()=>{void perform(load);return invalidate;},[perform,load,invalidate]);
 const requestReview=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!view||busyRef.current||pending&&!unrecorded)return;const parsed=guestHubProfileValuesSchema.safeParse(values);if(!parsed.success){setState("validation");return;}const idempotencyKey=nonce.current??crypto.randomUUID(),input={idempotencyKey,values:parsed.data,acknowledged};setNotice(null);void perform(async(signal,own)=>{const checked=guestHubProfileReviewSchema.parse(await guestHubRequest(path+"review",input,signal));if(checked.idempotencyKey!==idempotencyKey)throw new GuestHubBrowserError("uncertain");if(active(own)){setReview(checked);setState("ready");}});};
 const confirm=()=>{if(!review||busyRef.current)return;const checked=review;void perform(async(signal,own)=>{
  if(nonce.current&&nonce.current!==checked.idempotencyKey)throw new GuestHubBrowserError("uncertain");writeCommandNonce(key,checked.idempotencyKey);if(readCommandNonce(key)!==checked.idempotencyKey)throw new ProfileNonceStorageError();nonce.current=checked.idempotencyKey;setPending(true);setUnrecorded(false);clearPrivate();
  const receipt=guestHubProfileReceiptSchema.parse(await guestHubRequest(path+"admit",{idempotencyKey:checked.idempotencyKey,values:checked.values,acknowledged:checked.acknowledged,reviewFingerprint:checked.reviewFingerprint},signal));if(receipt.linkId!==linkId||receipt.idempotencyKey!==checked.idempotencyKey)throw new GuestHubBrowserError("uncertain");if(!active(own))return;clearCommandNonce(key,checked.idempotencyKey);nonce.current=null;setPending(false);setUnrecorded(false);setNotice("saved");await load(signal,own);
 });};
 const locked=busy||Boolean(pending&&!unrecorded),field=(name:keyof GuestHubProfileValues)=>values[name]??"";
 return <section className="resource-form guest-profile-form" data-testid="guest-profile-form" aria-busy={busy}>
  <h3>{t("title")}</h3><div aria-live="polite" data-testid="guest-profile-status"><p role={state==="ready"||state==="loading"?"status":"alert"}>{state==="ready"?t("loaded"):state==="loading"?t("loading"):state==="storage_unavailable"?t("storageUnavailable"):t("states."+state)}</p>{notice&&<p role="status">{t(notice)}</p>}</div>{busy&&<SkeletonBlock rows={2}/>}
  {pending&&<section className="resource-form" data-testid="guest-profile-pending"><p>{t(unrecorded?"unrecorded":"uncertain")}</p><button type="button" className="secondary-button" onClick={refresh} disabled={busy} data-testid="guest-profile-recover">{t("recover")}</button></section>}
  {view&&!review&&<form className="resource-form" onSubmit={requestReview} autoComplete="off" data-testid="guest-profile-inputs"><section className="resource-form" data-testid="guest-profile-notice"><h4 dir="auto">{localizedText(view.notice.title,locale)}</h4>{view.notice.paragraphs.map((paragraph,index)=><p key={index} dir="auto">{localizedText(paragraph,locale)}</p>)}</section>
   {view.allowedFields.map(name=><label className="field" key={name}><span>{t("fields."+name)}{view.requiredFields.includes(name)?" *":""}</span>{name==="preferredLocale"?<select name={name} value={field(name)} onChange={event=>setValues(current=>({...current,[name]:event.target.value||null}))} required={view.requiredFields.includes(name)} disabled={locked} data-testid={"guest-profile-"+name}><option value="">{t("empty")}</option>{(["en","fr","ar"]as const).map(language=><option key={language} value={language}>{access("languages."+language)}</option>)}</select>:<input name={name} type={name==="email"?"email":name==="phone"?"tel":"text"} value={field(name)} onChange={event=>setValues(current=>({...current,[name]:event.target.value||null}))} maxLength={name==="displayName"?200:name==="email"?254:80} autoComplete="off" required={view.requiredFields.includes(name)} disabled={locked} dir={name==="displayName"?"auto":"ltr"} data-testid={"guest-profile-"+name}/>}</label>)}
   {view.requireAcknowledgement&&<label className="field"><span><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} required disabled={locked} data-testid="guest-profile-acknowledge"/> {t("acknowledge")}</span></label>}
   <button type="submit" className="primary-button" disabled={locked} data-testid="guest-profile-review">{t("review")}</button>
  </form>}
  {view&&review&&<section className="resource-form" data-testid="guest-profile-review-record"><h4>{t("reviewTitle")}</h4><p>{t("reviewGuidance")}</p><dl>{view.allowedFields.map(name=><div key={name}><dt>{t("fields."+name)}</dt><dd dir="auto" className="guest-link-private-text">{review.values[name]==null?t("empty"):name==="preferredLocale"?access("languages."+review.values[name]):review.values[name]}</dd></div>)}</dl><div className="form-actions"><button type="button" className="primary-button" onClick={confirm} disabled={locked} data-testid="guest-profile-confirm">{t("confirm")}</button><button type="button" className="secondary-button" onClick={()=>setReview(null)} disabled={busy}>{t("edit")}</button></div></section>}
  <div className="form-actions">{!review&&<button type="button" className="secondary-button" onClick={refresh} disabled={busy} data-testid="guest-profile-refresh">{t("refresh")}</button>}<button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t("close")}</button></div>
 </section>;
}
