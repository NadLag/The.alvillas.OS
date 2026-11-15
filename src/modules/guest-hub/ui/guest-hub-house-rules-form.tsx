"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {guestHubHouseRulesViewSchema,guestHubHouseRulesReviewSchema,guestHubHouseRulesReceiptSchema,guestHubHouseRulesRecoveryResultSchema} from "../domain/guest-hub-house-rules-contract";
import {renderGuestHubHouseRulesContent,renderGuestHubHouseRulesNotice} from "../domain/guest-hub-house-rules-content";
import {guestHubRequest,GuestHubBrowserError,type GuestHubBrowserState} from "./guest-hub-browser";

type View=z.infer<typeof guestHubHouseRulesViewSchema>;
type Review=z.infer<typeof guestHubHouseRulesReviewSchema>;
class HouseRulesNonceStorageError extends Error{}

export function GuestHubHouseRulesForm({locale,linkId,onClose}:{locale:AppLocale;linkId:string;onClose:()=>void}){
 const t=useTranslations("GuestHouseRules"),[view,setView]=useState<View|null>(null),[acknowledged,setAcknowledged]=useState(false),[review,setReview]=useState<Review|null>(null),[state,setState]=useState<GuestHubBrowserState|"storage_unavailable">("loading"),[busy,setBusy]=useState(true),[pending,setPending]=useState(false),[unrecorded,setUnrecorded]=useState(false),[notice,setNotice]=useState<"saved"|"recovered"|"previousEdition"|null>(null);
 const controller=useRef<AbortController|null>(null),epoch=useRef(0),busyRef=useRef(false),nonce=useRef<string|null>(null),key="alvillas:guest-house-rules:"+linkId,path="links/"+linkId+"/house-rules/";
 const active=useCallback((own:number)=>own===epoch.current&&!controller.current?.signal.aborted,[]);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;busyRef.current=false;},[]);
 const clearPrivate=useCallback(()=>{setView(null);setReview(null);setAcknowledged(false);setNotice(null);},[]);
 const load=useCallback(async(signal:AbortSignal,own:number)=>{
  const original=nonce.current??readCommandNonce(key);
  if(original){nonce.current=original;setPending(true);const result=guestHubHouseRulesRecoveryResultSchema.parse(await guestHubRequest(path+"recover",{idempotencyKey:original},signal));if(result.linkId!==linkId||result.idempotencyKey!==original)throw new GuestHubBrowserError("uncertain");if(!active(own))return;if(result.recorded){clearCommandNonce(key,original);nonce.current=null;setPending(false);setUnrecorded(false);setNotice(result.currentEdition?"recovered":"previousEdition");}else setUnrecorded(true);}
  const current=guestHubHouseRulesViewSchema.parse(await guestHubRequest(path+"view",{},signal));if(current.linkId!==linkId)throw new GuestHubBrowserError("link_unavailable");if(active(own)){setView(current);setAcknowledged(false);setState("ready");}
 },[active,key,path,linkId]);
 const perform=useCallback(async(work:(signal:AbortSignal,own:number)=>Promise<void>)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setState("loading");controller.current?.abort();const selected=new AbortController();controller.current=selected;const own=++epoch.current;
  try{await work(selected.signal,own);}catch(error){if(active(own)){clearPrivate();setState(error instanceof HouseRulesNonceStorageError?"storage_unavailable":error instanceof GuestHubBrowserError?error.state:"unavailable");}}finally{if(active(own)){busyRef.current=false;setBusy(false);}}
 },[active,clearPrivate]);
 const refresh=useCallback(()=>{clearPrivate();void perform(load);},[clearPrivate,perform,load]);
 useEffect(()=>{
  void perform(load);const focus=()=>{if(document.visibilityState==="visible"&&!busyRef.current)refresh();},hidden=()=>{if(document.visibilityState==="hidden"){invalidate();clearPrivate();setBusy(false);setState("loading");}else focus();},offline=()=>{invalidate();clearPrivate();setBusy(false);setState("offline");};
  window.addEventListener("focus",focus);window.addEventListener("online",focus);window.addEventListener("offline",offline);document.addEventListener("visibilitychange",hidden);
  return()=>{invalidate();window.removeEventListener("focus",focus);window.removeEventListener("online",focus);window.removeEventListener("offline",offline);document.removeEventListener("visibilitychange",hidden);};
 },[clearPrivate,perform,load,refresh,invalidate]);
 const requestReview=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!view||view.currentAcceptance||!acknowledged||busyRef.current||pending&&!unrecorded)return;const current=view,idempotencyKey=nonce.current??crypto.randomUUID();setNotice(null);void perform(async(signal,own)=>{
  const checked=guestHubHouseRulesReviewSchema.parse(await guestHubRequest(path+"review",{idempotencyKey,locale,acknowledged:true},signal));
  if(checked.idempotencyKey!==idempotencyKey||checked.grantId!==current.grantId||checked.editionFingerprint!==current.editionFingerprint||checked.locale!==locale||JSON.stringify(checked.content)!==JSON.stringify(renderGuestHubHouseRulesContent(current.content,locale))||JSON.stringify(checked.notice)!==JSON.stringify(renderGuestHubHouseRulesNotice(current.notice,locale)))throw new GuestHubBrowserError("uncertain");
  if(active(own)){setReview(checked);setState("ready");}
 });};
 const confirm=()=>{if(!review||busyRef.current)return;const checked=review;void perform(async(signal,own)=>{
  if(nonce.current&&nonce.current!==checked.idempotencyKey)throw new GuestHubBrowserError("uncertain");writeCommandNonce(key,checked.idempotencyKey);if(readCommandNonce(key)!==checked.idempotencyKey)throw new HouseRulesNonceStorageError();nonce.current=checked.idempotencyKey;setPending(true);setUnrecorded(false);clearPrivate();
  const saved=guestHubHouseRulesReceiptSchema.parse(await guestHubRequest(path+"admit",{idempotencyKey:checked.idempotencyKey,locale:checked.locale,acknowledged:true,reviewFingerprint:checked.reviewFingerprint},signal));
  if(saved.linkId!==linkId||saved.idempotencyKey!==checked.idempotencyKey||saved.editionFingerprint!==checked.editionFingerprint||saved.requestedLocale!==checked.locale||saved.displayedLocale!==checked.content.locale||!saved.currentEdition)throw new GuestHubBrowserError("uncertain");if(!active(own))return;
  clearCommandNonce(key,checked.idempotencyKey);nonce.current=null;setPending(false);setUnrecorded(false);setNotice("saved");await load(signal,own);
 });};
 const locked=busy||Boolean(pending&&!unrecorded),content=review?.content??(view?renderGuestHubHouseRulesContent(view.content,locale):null),processingNotice=review?.notice??(view?renderGuestHubHouseRulesNotice(view.notice,locale):null);
 return <section className="resource-form guest-house-rules-form" data-testid="guest-house-rules-form" aria-busy={busy}>
  <h3>{t("title")}</h3><div aria-live="polite" data-testid="guest-house-rules-status"><p role={state==="ready"||state==="loading"?"status":"alert"}>{state==="ready"?t("loaded"):state==="loading"?t("loading"):state==="storage_unavailable"?t("storageUnavailable"):t("states."+state)}</p>{notice&&<p role="status">{t(notice)}</p>}</div>{busy&&<SkeletonBlock rows={2}/>}
  {pending&&<section className="resource-form" data-testid="guest-house-rules-pending"><p>{t(unrecorded?"unrecorded":"uncertain")}</p><button type="button" className="secondary-button" onClick={refresh} disabled={busy} data-testid="guest-house-rules-recover">{t("recover")}</button></section>}
  {content&&processingNotice&&<><section className="resource-form" data-testid="guest-house-rules-notice"><h4 dir="auto">{processingNotice.title}</h4>{processingNotice.paragraphs.map((text,index)=><p key={index} dir="auto">{text}</p>)}</section><section className="resource-form" data-testid="guest-house-rules-content" lang={content.locale} dir={content.locale==="ar"?"rtl":"ltr"}><h4>{content.title}</h4>{content.locale!==locale&&<p>{t("approvedLanguageFallback")}</p>}<ol>{content.rules.map((text,index)=><li key={index}>{text}</li>)}</ol></section></>}
  {view?.currentAcceptance&&<section className="resource-form" data-testid="guest-house-rules-accepted"><p>{t("accepted",{date:new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short"}).format(new Date(view.currentAcceptance.createdAt))})}</p></section>}
  {view&&!view.currentAcceptance&&!review&&content&&<form className="resource-form" onSubmit={requestReview} autoComplete="off"><label className="field"><span><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} required disabled={locked} data-testid="guest-house-rules-acknowledge"/> <span lang={content.locale} dir="auto">{content.acceptanceStatement}</span></span></label><button type="submit" className="primary-button" disabled={locked||!acknowledged} data-testid="guest-house-rules-review">{t("review")}</button></form>}
  {review&&<section className="resource-form" data-testid="guest-house-rules-review-record"><h4>{t("reviewTitle")}</h4><p>{t("reviewGuidance")}</p><p lang={review.content.locale} dir="auto" data-testid="guest-house-rules-acceptance-statement">{review.content.acceptanceStatement}</p><div className="form-actions"><button type="button" className="primary-button" onClick={confirm} disabled={locked} data-testid="guest-house-rules-confirm">{t("confirm")}</button><button type="button" className="secondary-button" onClick={()=>setReview(null)} disabled={busy}>{t("edit")}</button></div></section>}
  <div className="form-actions">{!review&&<button type="button" className="secondary-button" onClick={refresh} disabled={busy} data-testid="guest-house-rules-refresh">{t("refresh")}</button>}<button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t("close")}</button></div>
 </section>;
}
