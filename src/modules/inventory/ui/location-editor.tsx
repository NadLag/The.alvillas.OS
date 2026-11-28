"use client";
import {useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {inventoryLocationChangeSchema,type inventoryLocationKindSchema} from "../domain/location-catalog";
import {inventoryLocationPreviewSchema,inventoryLocationPublishSchema,type InventoryLocationView,type InventoryLocationPreview} from "../domain/location-view";
import {inventoryCatalogRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
import {InventoryLocationPropertyPicker} from "./location-property-picker";
import type {z} from "zod";
type Props={scope:string;nonceKey:string;initial:InventoryLocationView|null;operation:"CREATE"|"RENAME"|"ARCHIVE"|"RESTORE";onClose:()=>void;onSaved:()=>void;onUnknown:()=>void;onDenied:()=>void};
export function InventoryLocationEditor({scope,nonceKey,initial,operation,onClose,onSaved,onUnknown,onDenied}:Props){
 const t=useTranslations("InventoryLocations"),id=useId(),[label,setLabel]=useState(initial?.label??""),[kind,setKind]=useState<z.infer<typeof inventoryLocationKindSchema>>(initial?.kind??"STORE"),[property,setProperty]=useState<{id:string;name:string}|null>(initial?.propertyId?{id:initial.propertyId,name:initial.propertyName??""}:null),[picker,setPicker]=useState(false),[reason,setReason]=useState(""),[review,setReview]=useState<InventoryLocationPreview|null>(null),[state,setState]=useState<InventoryBrowserState>("ready"),[busy,setBusy]=useState(false),controller=useRef<AbortController|null>(null),active=useRef(true),publishing=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();};},[]);
 function failure(error:unknown){const state=error instanceof InventoryBrowserError?error.state:"validation";if(state==="forbidden")onDenied();else setState(state);}
 async function preview(event:FormEvent){
  event.preventDefault();if(busy||publishing.current)return;setBusy(true);setPicker(false);setState("ready");const abort=new AbortController();controller.current=abort;
  try{
   const entry={kind,propertyId:kind==="PROPERTY"?property?.id??null:null,label},draft=inventoryLocationChangeSchema.parse(operation==="CREATE"?{operation,entry,reason}:operation==="RENAME"?{operation,id:initial!.id,entry,reason}:{operation,id:initial!.id,reason}),value=inventoryLocationPreviewSchema.parse(await inventoryCatalogRequest("locations","review",draft,abort.signal,scope));
   if(JSON.stringify(value.draft)!==JSON.stringify(draft))throw new InventoryBrowserError("conflict");if(active.current&&!abort.signal.aborted)setReview(value);
  }catch(error){if(active.current&&!abort.signal.aborted)failure(error);}finally{if(active.current)setBusy(false);}
 }
 async function publish(){
  if(!review||busy||publishing.current)return;publishing.current=true;setBusy(true);setState("ready");const abort=new AbortController();controller.current=abort;const nonce=crypto.randomUUID();writeCommandNonce(nonceKey,nonce);
  if(readCommandNonce(nonceKey)!==nonce){publishing.current=false;setBusy(false);setState("unavailable");return;}
  try{const value=inventoryLocationPublishSchema.parse(await inventoryCatalogRequest("locations","publish",{draft:review.draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:nonce},abort.signal,scope));if(value.organizationId+"."+value.actorId!==scope||value.operation!==operation||operation!=="CREATE"&&value.locationId!==initial?.id)throw new InventoryBrowserError("uncertain");clearCommandNonce(nonceKey,nonce);if(active.current&&!abort.signal.aborted)onSaved();}
  catch(error){if(error instanceof InventoryBrowserError&&["validation","conflict","stock_held","forbidden"].includes(error.state)){clearCommandNonce(nonceKey,nonce);if(active.current){setReview(null);failure(error);}}else if(active.current)onUnknown();}
  finally{publishing.current=false;if(active.current)setBusy(false);}
 }
 const changing=operation==="CREATE"||operation==="RENAME";
 return <section className="detail-panel resource-form" data-testid="inventory-location-editor"><h2>{t("operations."+operation)}</h2>{initial?<p dir="auto">{initial.label}</p>:null}
  <form className="resource-form" onSubmit={event=>void preview(event)}><fieldset disabled={busy||Boolean(review)}>{changing?<><div className="form-grid"><div className="field"><label htmlFor={id+"label"}>{t("fields.label")}</label><input id={id+"label"} data-testid="inventory-location-label" dir="auto" required maxLength={240} value={label} onChange={event=>{setLabel(event.target.value);setReview(null);}}/></div><div className="field"><label htmlFor={id+"kind"}>{t("kind")}</label><select id={id+"kind"} data-testid="inventory-location-kind" value={kind} disabled={operation!=="CREATE"} onChange={event=>{setKind(event.target.value as typeof kind);setProperty(null);setReview(null);setPicker(false);}}>{(["PROPERTY","STORE","LAUNDRY","IN_TRANSIT"]as const).map(value=><option value={value} key={value}>{t("kinds."+value)}</option>)}</select></div></div>{kind==="PROPERTY"?<div><p>{t("fields.property")} · <span dir="auto">{property?.name??t("propertyRequired")}</span></p>{operation==="CREATE"?<button type="button" className="secondary-button" onClick={()=>setPicker(true)}>{t("chooseProperty")}</button>:null}</div>:null}<p className="muted-copy">{t("identityHelp")}</p></>:<p>{t(operation==="ARCHIVE"?"retireHelp":"restoreHelp")}</p>}<div className="field"><label htmlFor={id+"reason"}>{t("fields.reason")}</label><input id={id+"reason"} data-testid="inventory-location-reason" dir="auto" required minLength={6} maxLength={500} value={reason} onChange={event=>{setReason(event.target.value);setReview(null);}}/></div><button type="submit" className="primary-button" disabled={changing&&kind==="PROPERTY"&&!property}>{t("review")}</button></fieldset></form>
  {picker&&!busy&&!review?<InventoryLocationPropertyPicker scope={scope} onDenied={onDenied} onClose={()=>setPicker(false)} onSelect={value=>{setProperty(value);setReview(null);setPicker(false);}}/>:null}
  {review?<section aria-label={t("reviewTitle")}><h3>{t("reviewTitle")}</h3><p>{t("reviewHelp")}</p>{"entry"in review.draft?<><p dir="auto">{review.draft.entry.label}</p><p>{t("kinds."+review.draft.entry.kind)}</p></>:null}{review.property?<p dir="auto">{review.property.name}</p>:null}<p dir="auto">{review.draft.reason}</p><div className="form-actions"><button className="primary-button" type="button" disabled={busy} onClick={()=>void publish()}>{t(busy?"saving":"publish")}</button><button className="secondary-button" type="button" disabled={busy} onClick={()=>setReview(null)}>{t("changeReview")}</button></div></section>:null}{state!=="ready"?<p role="alert">{t("states."+state)}</p>:null}<button className="quiet-button" type="button" disabled={busy} onClick={onClose}>{t("close")}</button>
 </section>;
}
