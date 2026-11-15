"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import dynamic from "next/dynamic";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {EmptyState,SkeletonBlock,StatusBadge} from "@/design-system/shells";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {guestHubWorkspaceSchema,guestHubIssueReviewSchema,guestHubRevokeReviewSchema,guestHubStaffReceiptSchema,guestHubRevokeReceiptSchema,guestHubRecoveryResultSchema,guestHubRevocationRecoveryResultSchema} from "../domain/guest-hub-contract";
import {guestHubRequest,GuestHubBrowserError,type GuestHubBrowserState} from "./guest-hub-browser";

const GuestHubProfileGrantManager=dynamic(()=>import("./guest-hub-profile-grant-manager").then(module=>module.GuestHubProfileGrantManager),{loading:()=> <SkeletonBlock rows={2}/>});

const GuestHubHouseRulesGrantManager=dynamic(()=>import("./guest-hub-house-rules-grant-manager").then(module=>module.GuestHubHouseRulesGrantManager),{loading:()=> <SkeletonBlock rows={2}/>});
const GuestHubStayDetailsGrantManager=dynamic(()=>import("./guest-hub-stay-details-grant-manager").then(module=>module.GuestHubStayDetailsGrantManager),{loading:()=> <SkeletonBlock rows={2}/>});

const GuestHubIdentityGrantManager=dynamic(()=>import("./guest-hub-identity-grant-manager").then(module=>module.GuestHubIdentityGrantManager),{loading:()=> <SkeletonBlock rows={2}/>});

type Workspace=z.infer<typeof guestHubWorkspaceSchema>;
type Pending={kind:"issue";nonce:string}|{kind:"revoke";nonce:string;linkId:string};
type Review={kind:"issue";value:z.infer<typeof guestHubIssueReviewSchema>;reason:string}|{kind:"revoke";value:z.infer<typeof guestHubRevokeReviewSchema>;reason:string};
class NonceStorageError extends Error{}

export function GuestHubManager({locale,scope,reservationId}:{locale:AppLocale;scope:string;reservationId:string}){
 const houseRulesLabels=useTranslations("GuestHouseRulesManagement"),identityLabels=useTranslations("GuestIdentityManagement"),profileLabels=useTranslations("GuestProfileManagement"),stayLabels=useTranslations("GuestStayDetailsManagement"),t=useTranslations("GuestLinkManagement"),[metadata,setMetadata]=useState<Workspace|null>(null),[state,setState]=useState<GuestHubBrowserState|"storage_unavailable">("loading"),[busy,setBusy]=useState(true),[pending,setPending]=useState<Pending|null>(null),[unrecorded,setUnrecorded]=useState(false),[review,setReview]=useState<Review|null>(null),[reason,setReason]=useState(""),[revokeId,setRevokeId]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[fallback,setFallback]=useState<string|null>(null),[managedForm,setManagedForm]=useState<{kind:"PROFILE"|"STAY_DETAILS"|"IDENTITY_DOCUMENTS"|"HOUSE_RULES";linkId:string}|null>(null);
 const controller=useRef<AbortController|null>(null),epoch=useRef(0),busyRef=useRef(false),pendingRef=useRef<Pending|null>(null),nonceKey="alvillas:guest-hub:"+scope+":"+reservationId,issueKey=nonceKey+":issue",revokePointer=nonceKey+":revoke-link";
 const active=useCallback((own:number)=>own===epoch.current&&!controller.current?.signal.aborted,[]);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;busyRef.current=false;},[]);
 const clearPending=useCallback((selected:Pending)=>{if(selected.kind==="issue")clearCommandNonce(issueKey,selected.nonce);else{clearCommandNonce(nonceKey+":revoke:"+selected.linkId,selected.nonce);clearCommandNonce(revokePointer,selected.linkId);}pendingRef.current=null;setPending(null);setUnrecorded(false);},[issueKey,nonceKey,revokePointer]);
 const restorePending=useCallback((value?:Workspace)=>{
  if(pendingRef.current)return pendingRef.current;const issue=readCommandNonce(issueKey);if(issue)return{kind:"issue"as const,nonce:issue};
  const pointer=readCommandNonce(revokePointer),ids=[...new Set([...(pointer?[pointer]:[]),...value?.items.map(item=>item.id)??[]])];for(const id of ids){const nonce=readCommandNonce(nonceKey+":revoke:"+id);if(nonce)return{kind:"revoke"as const,nonce,linkId:id};}return null;
 },[issueKey,revokePointer,nonceKey]);
 const load=useCallback(async(signal:AbortSignal,own:number,cursor?:string)=>{
  let value=guestHubWorkspaceSchema.parse(await guestHubRequest("directory",{reservationId,...cursor?{cursor}:{}},signal,scope));if(value.reservationId!==reservationId)throw new GuestHubBrowserError("unavailable");if(!active(own))return;
  const selected=restorePending(value);if(selected){pendingRef.current=selected;setPending(selected);
   if(selected.kind==="issue"){
    const recovered=guestHubRecoveryResultSchema.parse(await guestHubRequest("issue/recover",{reservationId,idempotencyKey:selected.nonce},signal,scope));if(recovered.reservationId!==reservationId||recovered.idempotencyKey!==selected.nonce)throw new GuestHubBrowserError("uncertain");if(!active(own))return;
    if(recovered.recorded){clearPending(selected);setNotice("recovered");value=guestHubWorkspaceSchema.parse(await guestHubRequest("directory",{reservationId},signal,scope));}else{setUnrecorded(true);setRevokeId(null);}
   }else{
    const recovered=guestHubRevocationRecoveryResultSchema.parse(await guestHubRequest("revoke/recover",{linkId:selected.linkId,idempotencyKey:selected.nonce},signal,scope));if(recovered.linkId!==selected.linkId||recovered.idempotencyKey!==selected.nonce)throw new GuestHubBrowserError("uncertain");if(!active(own))return;
    if(recovered.recorded||recovered.alreadyRevoked){clearPending(selected);setNotice(recovered.recorded?"recovered":"alreadyRevoked");value=guestHubWorkspaceSchema.parse(await guestHubRequest("directory",{reservationId},signal,scope));}else{setUnrecorded(true);setRevokeId(selected.linkId);}
   }
  }
  if(value.reservationId!==reservationId)throw new GuestHubBrowserError("unavailable");if(active(own)){setMetadata(value);setState("ready");}
 },[reservationId,scope,active,restorePending,clearPending]);
 const fail=useCallback((error:unknown,own:number)=>{if(!active(own))return;const next=error instanceof NonceStorageError?"storage_unavailable":error instanceof GuestHubBrowserError?error.state:"unavailable";setState(next);if(next==="forbidden"){setMetadata(null);setReview(null);setReason("");setRevokeId(null);}},[active]);
 const perform=useCallback(async(work:(signal:AbortSignal,own:number)=>Promise<void>)=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setFallback(null);setNotice(null);controller.current?.abort();const selected=new AbortController();controller.current=selected;const own=++epoch.current;
  try{await work(selected.signal,own);}catch(error){fail(error,own);}
  finally{if(active(own)){busyRef.current=false;setBusy(false);}}
 },[active,fail]);
 const refresh=useCallback(()=>{void perform(async(signal,own)=>{setReview(null);await load(signal,own);});},[perform,load]);
 useEffect(()=>{
  pendingRef.current=restorePending();const initial=new AbortController();controller.current=initial;const own=++epoch.current;busyRef.current=true;void load(initial.signal,own).catch(error=>fail(error,own)).finally(()=>{if(active(own)){busyRef.current=false;setBusy(false);}});
  const focus=()=>{if(document.visibilityState==="visible"&&!busyRef.current){setFallback(null);setMetadata(null);setState("loading");refresh();}},visibility=()=>{if(document.visibilityState==="hidden"){invalidate();setFallback(null);setMetadata(null);setReview(null);setState("loading");setBusy(false);}else focus();},offline=()=>{invalidate();setFallback(null);setMetadata(null);setReview(null);setState("offline");setBusy(false);};
  window.addEventListener("focus",focus);window.addEventListener("online",focus);window.addEventListener("offline",offline);document.addEventListener("visibilitychange",visibility);return()=>{invalidate();window.removeEventListener("focus",focus);window.removeEventListener("online",focus);window.removeEventListener("offline",offline);document.removeEventListener("visibilitychange",visibility);};
 },[refresh,restorePending,invalidate,load,fail,active]);
 const persist=(selected:Pending)=>{
  if(selected.kind==="issue"){writeCommandNonce(issueKey,selected.nonce);if(readCommandNonce(issueKey)!==selected.nonce)throw new NonceStorageError();}
  else{writeCommandNonce(nonceKey+":revoke:"+selected.linkId,selected.nonce);writeCommandNonce(revokePointer,selected.linkId);if(readCommandNonce(nonceKey+":revoke:"+selected.linkId)!==selected.nonce||readCommandNonce(revokePointer)!==selected.linkId)throw new NonceStorageError();}
  pendingRef.current=selected;setPending(selected);setUnrecorded(false);
 };
 const requestReview=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!metadata||busyRef.current)return;const rationale=reason.trim(),selectedRevoke=revokeId;void perform(async(signal,own)=>{
  if(selectedRevoke){const value=guestHubRevokeReviewSchema.parse(await guestHubRequest("revoke/review",{linkId:selectedRevoke},signal,scope));if(value.linkId!==selectedRevoke||value.reservationId!==reservationId||value.revoked)throw new GuestHubBrowserError("conflict");if(active(own)){setReview({kind:"revoke",value,reason:rationale});setState("ready");}}
  else{const value=guestHubIssueReviewSchema.parse(await guestHubRequest("issue/review",{reservationId},signal,scope));if(value.reservationId!==reservationId||value.propertyId!==metadata.propertyId)throw new GuestHubBrowserError("conflict");if(active(own)){setReview({kind:"issue",value,reason:rationale});setState("ready");}}
 });};
 const confirm=()=>{if(!review||busyRef.current)return;const checked=review;void perform(async(signal,own)=>{
  if(checked.kind==="issue"){
   if(pendingRef.current&&pendingRef.current.kind!=="issue")throw new GuestHubBrowserError("uncertain");const selected:Pending={kind:"issue",nonce:pendingRef.current?.nonce??crypto.randomUUID()};persist(selected);setReview(null);
   const saved=guestHubStaffReceiptSchema.parse(await guestHubRequest("issue/admit",{reservationId,idempotencyKey:selected.nonce,reviewFingerprint:checked.value.reviewFingerprint,reason:checked.reason},signal,scope));if(saved.reservationId!==reservationId||saved.propertyId!==checked.value.propertyId||saved.idempotencyKey!==selected.nonce||saved.expiresAt!==checked.value.expiresAt)throw new GuestHubBrowserError("uncertain");if(!active(own))return;clearPending(selected);setReason("");setNotice("created");await load(signal,own);
  }else{
   if(pendingRef.current&&(pendingRef.current.kind!=="revoke"||pendingRef.current.linkId!==checked.value.linkId))throw new GuestHubBrowserError("uncertain");const selected:Pending={kind:"revoke",linkId:checked.value.linkId,nonce:pendingRef.current?.nonce??crypto.randomUUID()};persist(selected);setReview(null);
   const saved=guestHubRevokeReceiptSchema.parse(await guestHubRequest("revoke/admit",{linkId:selected.linkId,idempotencyKey:selected.nonce,reviewFingerprint:checked.value.reviewFingerprint,reason:checked.reason},signal,scope));if(saved.linkId!==selected.linkId||saved.idempotencyKey!==selected.nonce)throw new GuestHubBrowserError("uncertain");if(!active(own))return;clearPending(selected);setReason("");setRevokeId(null);setNotice("revoked");await load(signal,own);
  }
 });};
 const copy=(item:Workspace["items"][number])=>{if(!item.recoveryKey||!metadata)return;const nonce=item.recoveryKey,guestLocale=metadata.locale;void perform(async(signal,own)=>{
  const recovered=guestHubRecoveryResultSchema.parse(await guestHubRequest("issue/recover",{reservationId,idempotencyKey:nonce},signal,scope));if(!recovered.recorded||recovered.idempotencyKey!==nonce||recovered.reservationId!==reservationId||recovered.id!==item.id||recovered.state!=="ACTIVE"||!recovered.token)throw new GuestHubBrowserError("conflict");if(!active(own))return;const value=window.location.origin+"/"+guestLocale+"/guest#"+recovered.token;
  try{await navigator.clipboard.writeText(value);if(active(own))setNotice("copied");}catch{if(active(own)){setFallback(value);setNotice("copyManually");}}if(active(own))setState("ready");
 });};
 const stamp=(value:string)=>new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(value)),locked=busy||state==="offline"||Boolean(pending&&!unrecorded),canReview=metadata&&(revokeId||metadata.canCreate&&metadata.issuanceAvailable)&&(!pending||unrecorded);
 return <section className="resource-form guest-link-manager" data-testid="guest-link-manager" aria-busy={busy}>
  <div aria-live="polite" data-testid="guest-link-status"><p role={state!=="ready"&&state!=="loading"?"alert":"status"}>{t(busy?"working":state==="ready"?"loaded":state==="loading"?"loading":"states."+state)}</p>{notice&&<p role="status">{t("notices."+notice)}</p>}</div>{busy&&<SkeletonBlock rows={2}/>}
  {metadata&&<h2 dir="auto">{t("reservation",{reference:metadata.reference})}</h2>}
  {pending&&<section className="resource-form" data-testid="guest-link-pending"><p>{t(unrecorded?"unrecorded":"uncertain")}</p><button type="button" className="primary-button" onClick={refresh} disabled={busy||state==="offline"} data-testid="guest-link-recover">{t("recover")}</button></section>}
  {canReview&&!review&&<form className="resource-form" onSubmit={requestReview} data-testid="guest-link-form"><h3>{t(revokeId?"revokeTitle":"createTitle")}</h3><label className="field"><span>{t("reason")}</span><textarea name="reason" value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000} required autoComplete="off" dir="auto" disabled={locked}/></label><button type="submit" className="primary-button" disabled={locked} data-testid="guest-link-review">{t(revokeId?"reviewRevoke":"reviewCreate")}</button>{revokeId&&!pending&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>{setRevokeId(null);setReason("");}}>{t("cancel")}</button>}</form>}
  {review&&<section className="resource-form" data-testid="guest-link-review-record"><h3>{t(review.kind==="issue"?"confirmCreateTitle":"confirmRevokeTitle")}</h3><p>{t(review.kind==="issue"?"confirmCreateGuidance":"confirmRevokeGuidance")}</p>{review.kind==="revoke"&&<p>{t("createdAt",{date:stamp(review.value.createdAt)})}</p>}<p>{t("originalExpiry",{date:stamp(review.value.expiresAt)})}</p><p className="guest-link-private-text" dir="auto">{review.reason}</p><div className="form-actions"><button type="button" className="primary-button" onClick={confirm} disabled={locked} data-testid="guest-link-confirm">{t(review.kind==="issue"?"confirmCreate":"confirmRevoke")}</button><button type="button" className="secondary-button" onClick={()=>setReview(null)} disabled={busy}>{t("cancel")}</button></div></section>}
  {metadata&&!metadata.issuanceAvailable&&<p role="status">{t("issuanceUnavailable")}</p>}
  {fallback&&<label className="field"><span>{t("shareableLink")}</span><input type="text" value={fallback} readOnly autoComplete="off" dir="ltr" onFocus={event=>event.target.select()} data-testid="guest-link-shareable"/></label>}
  {metadata&&<section data-testid="guest-link-history"><h3>{t("history")}</h3>{metadata.items.length===0?<EmptyState>{t("empty")}</EmptyState>:<ol className="guest-link-history">{metadata.items.map(item=><li key={item.id} className="resource-form" data-testid="guest-link-history-row"><div><StatusBadge tone={item.state==="ACTIVE"?"success":item.state==="REVOKED"?"neutral":"warning"}>{t("linkStates."+item.state)}</StatusBadge><p>{t("createdAt",{date:stamp(item.createdAt)})}</p><p>{t("originalExpiry",{date:stamp(item.expiresAt)})}</p><p>{t(item.originalCreator?"createdByYou":"createdByTeam")}</p></div><div className="form-actions">{item.recoveryKey&&item.state==="ACTIVE"&&<button type="button" className="secondary-button" onClick={()=>copy(item)} disabled={locked} data-testid="guest-link-copy">{t("copy")}</button>}{item.canManageProfile&&<button type="button" className="secondary-button" onClick={()=>setManagedForm({kind:"PROFILE",linkId:item.id})} disabled={locked} data-testid="guest-profile-grant-open">{profileLabels("title")}</button>}{item.canManageStayDetails&&<button type="button" className="secondary-button" onClick={()=>setManagedForm({kind:"STAY_DETAILS",linkId:item.id})} disabled={locked} data-testid="guest-stay-details-grant-open">{stayLabels("title")}</button>}{item.canManageIdentityDocuments&&<button type="button" className="secondary-button" onClick={()=>setManagedForm({kind:"IDENTITY_DOCUMENTS",linkId:item.id})} disabled={locked} data-testid="guest-identity-grant-open">{identityLabels("title")}</button>}{item.canManageHouseRules&&<button type="button" className="secondary-button" onClick={()=>setManagedForm({kind:"HOUSE_RULES",linkId:item.id})} disabled={locked} data-testid="guest-house-rules-grant-open">{houseRulesLabels("title")}</button>}{item.canRevoke&&<button type="button" className="secondary-button" onClick={()=>{setRevokeId(item.id);setReview(null);setReason("");}} disabled={locked||Boolean(pending)} data-testid="guest-link-revoke">{t("revoke")}</button>}</div></li>)}</ol>}{metadata.next&&<button type="button" className="secondary-button" disabled={locked||Boolean(pending)} onClick={()=>{const cursor=metadata.next!;void perform((signal,own)=>load(signal,own,cursor));}} data-testid="guest-link-next">{t("next")}</button>}</section>}
  {metadata&&managedForm?.kind==="PROFILE"&&<GuestHubProfileGrantManager key={scope+":"+managedForm.linkId} locale={locale} scope={scope} reservationId={reservationId} linkId={managedForm.linkId} onClose={()=>setManagedForm(null)}/>}
  {metadata&&managedForm?.kind==="HOUSE_RULES"&&<GuestHubHouseRulesGrantManager key={scope+":"+managedForm.linkId} locale={locale} scope={scope} reservationId={reservationId} linkId={managedForm.linkId} onClose={()=>setManagedForm(null)}/>}
  {metadata&&managedForm?.kind==="STAY_DETAILS"&&<GuestHubStayDetailsGrantManager key={scope+":"+managedForm.linkId} locale={locale} scope={scope} reservationId={reservationId} linkId={managedForm.linkId} onClose={()=>setManagedForm(null)}/>}
  {metadata&&managedForm?.kind==="IDENTITY_DOCUMENTS"&&<GuestHubIdentityGrantManager key={scope+":"+managedForm.linkId} locale={locale} scope={scope} reservationId={reservationId} linkId={managedForm.linkId} onClose={()=>setManagedForm(null)}/>}
  <div className="form-actions">{!pending&&!review&&<button type="button" className="secondary-button" onClick={refresh} disabled={busy||state==="offline"} data-testid="guest-link-refresh">{t("refresh")}</button>}<a className="secondary-button" href={"/"+locale+"/app/reservations/"+reservationId}>{t("back")}</a></div>
 </section>;
}
