"use client";
import {useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {readCommandNonce,writeCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {inventoryItemChangeSchema} from "../domain/item-command";
import {inventoryItemPreviewSchema,inventoryItemPublishSchema,type InventoryItemView,type InventoryItemPreview} from "../domain/item-view";
import {inventoryItemRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
type Props={locale:AppLocale;scope:string;nonceKey:string;initial:InventoryItemView|null;operation:"CREATE"|"RENAME"|"ARCHIVE"|"RESTORE";onClose:()=>void;onSaved:()=>void;onUnknown:()=>void;onDenied:()=>void};
export function InventoryItemEditor({locale,scope,nonceKey,initial,operation,onClose,onSaved,onUnknown,onDenied}:Props){
 const t=useTranslations("InventoryItems"),id=useId(),[fields,setFields]=useState({key:initial?.key??"",unit:initial?.unit??"",category:initial?.category??"CONSUMABLE",en:initial?.name.en??"",fr:initial?.name.fr??"",ar:initial?.name.ar??"",reason:""}),[review,setReview]=useState<InventoryItemPreview|null>(null),[state,setState]=useState<InventoryBrowserState>("ready"),[busy,setBusy]=useState(false),controller=useRef<AbortController|null>(null),active=useRef(true),publishing=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();};},[]);
 const changing=operation==="CREATE"||operation==="RENAME";
 function error(error:unknown){const state=error instanceof InventoryBrowserError?error.state:"validation";if(state==="forbidden")onDenied();else setState(state);}
 async function preview(event:FormEvent){
  event.preventDefault();if(busy||publishing.current)return;setBusy(true);setState("ready");const abort=new AbortController();controller.current=abort;
  try{
   const entry={key:fields.key,unit:initial?.unit===null?null:fields.unit,category:fields.category,name:{en:fields.en,fr:fields.fr,...fields.ar.trim()?{ar:fields.ar}:{}}},draft=inventoryItemChangeSchema.parse(operation==="CREATE"?{operation,entry,reason:fields.reason}:operation==="RENAME"?{operation,id:initial!.id,entry,reason:fields.reason}:{operation,id:initial!.id,reason:fields.reason});
   const value=inventoryItemPreviewSchema.parse(await inventoryItemRequest("review",draft,abort.signal,scope));
   if(JSON.stringify(value.draft)!==JSON.stringify(draft))throw new InventoryBrowserError("conflict");if(active.current&&!abort.signal.aborted)setReview(value);
  }catch(value){if(active.current&&!abort.signal.aborted)error(value);}finally{if(active.current)setBusy(false);}
 }
 async function publish(){
  if(!review||busy||publishing.current)return;publishing.current=true;setBusy(true);setState("ready");const abort=new AbortController();controller.current=abort;const nonce=crypto.randomUUID();writeCommandNonce(nonceKey,nonce);
  if(readCommandNonce(nonceKey)!==nonce){publishing.current=false;setBusy(false);setState("unavailable");return;}
  try{
   const result=inventoryItemPublishSchema.parse(await inventoryItemRequest("publish",{draft:review.draft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:nonce},abort.signal,scope));
   if(result.organizationId+"."+result.actorId!==scope||result.operation!==operation||operation!=="CREATE"&&result.itemId!==initial?.id)throw new InventoryBrowserError("uncertain");
   clearCommandNonce(nonceKey,nonce);if(active.current&&!abort.signal.aborted)onSaved();
  }catch(value){
   if(value instanceof InventoryBrowserError&&["validation","conflict","stock_held","forbidden"].includes(value.state)){clearCommandNonce(nonceKey,nonce);if(active.current){setReview(null);error(value);}}
   else if(active.current)onUnknown();
  }finally{publishing.current=false;if(active.current)setBusy(false);}
 }
 const text=(key:"key"|"unit"|"en"|"fr"|"ar"|"reason",required:boolean)=><div className="field"><label htmlFor={id+key}>{t("fields."+key)}</label><input id={id+key} data-testid={"inventory-item-"+key} dir="auto" value={fields[key]} required={required} minLength={key==="reason"?6:undefined} maxLength={key==="key"?120:key==="unit"?60:key==="reason"?500:240} disabled={operation!=="CREATE"&&(key==="key"||key==="unit")} onChange={event=>{setFields(current=>({...current,[key]:event.target.value}));setReview(null);}}/></div>;
 return <section className="detail-panel resource-form" data-testid="inventory-item-editor"><h2>{t("operations."+operation)}</h2>
  {initial?<p dir="auto">{localizedText(initial.name,locale)} · {initial.key}</p>:null}
  <form className="resource-form" onSubmit={event=>void preview(event)}><fieldset disabled={busy||Boolean(review)}>{changing?<><div className="form-grid">{text("key",true)}{text("unit",operation==="CREATE")}<div className="field"><label htmlFor={id+"category"}>{t("category")}</label><select id={id+"category"} data-testid="inventory-item-category" value={fields.category} disabled={operation!=="CREATE"} onChange={event=>setFields(current=>({...current,category:event.target.value as typeof current.category}))}>{(["CONSUMABLE","LINEN","EQUIPMENT"]as const).map(category=><option key={category} value={category}>{t("categories."+category)}</option>)}</select></div>{text("en",true)}{text("fr",true)}{text("ar",false)}</div><p className="muted-copy">{t("identityHelp")}</p></>:<p>{t(operation==="ARCHIVE"?"retireHelp":"restoreHelp")}</p>}{text("reason",true)}<button className="primary-button" type="submit">{t("review")}</button></fieldset></form>
  {review?<section aria-label={t("reviewTitle")}><h3>{t("reviewTitle")}</h3><p>{t("reviewHelp")}</p>{"entry"in review.draft?<dl><dt>{t("fields.key")}</dt><dd dir="auto">{review.draft.entry.key}</dd>{(["en","fr","ar"]as const).map(language=><div key={language}><dt>{t("fields."+language)}</dt><dd dir="auto">{review.draft.operation==="CREATE"||review.draft.operation==="RENAME"?review.draft.entry.name[language]??t("notProvided"):null}</dd></div>)}<dt>{t("fields.unit")}</dt><dd dir="auto">{review.draft.entry.unit??t("unspecifiedUnit")}</dd><dt>{t("category")}</dt><dd>{t("categories."+review.draft.entry.category)}</dd></dl>:null}<p dir="auto">{review.draft.reason}</p><div className="form-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void publish()}>{t(busy?"saving":"publish")}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setReview(null)}>{t("changeReview")}</button></div></section>:null}
  {state!=="ready"?<p role="alert">{t("states."+state)}</p>:null}<button type="button" className="quiet-button" disabled={busy} onClick={onClose}>{t("close")}</button>
 </section>;
}
