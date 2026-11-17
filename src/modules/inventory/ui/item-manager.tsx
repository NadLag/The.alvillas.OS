"use client";
import dynamic from "next/dynamic";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {inventoryItemPageSchema,inventoryItemRecoverySchema,type InventoryItemView} from "../domain/item-view";
import {inventoryItemRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
const Editor=dynamic(()=>import("./item-editor").then(module=>module.InventoryItemEditor),{loading:()=> <SkeletonBlock/>});
type Editing={initial:InventoryItemView|null;operation:"CREATE"|"RENAME"|"ARCHIVE"|"RESTORE"};
export function InventoryItemManager({locale,authorizationScope:scope}:{locale:AppLocale;authorizationScope:string}){
 const t=useTranslations("InventoryItems"),id=useId(),nonceKey="alvillas:inventory-item:"+scope,[page,setPage]=useState<z.infer<typeof inventoryItemPageSchema>|null>(null),[state,setState]=useState<InventoryBrowserState>("loading"),[query,setQuery]=useState(""),[category,setCategory]=useState(""),[archived,setArchived]=useState(false),[editor,setEditor]=useState<Editing|null>(null),[visible,setVisible]=useState(true),[notice,setNotice]=useState<"saved"|"unconfirmed"|"notRecorded"|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const denied=useCallback(()=>{invalidate();setPage(null);setEditor(null);setQuery("");setNotice(null);setState("forbidden");},[invalidate]);
 const load=useCallback(async(search="",after?:string)=>{
  invalidate();const own=epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setEditor(null);setState("loading");
  try{
   const nonce=readCommandNonce(nonceKey);if(nonce){const recovered=inventoryItemRecoverySchema.parse(await inventoryItemRequest("recover",{idempotencyKey:nonce},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;clearCommandNonce(nonceKey,nonce);setNotice(recovered.recorded?"saved":"notRecorded");}
   const value=inventoryItemPageSchema.parse(await inventoryItemRequest("page",{query:search,archived,...category?{category}:{},...after?{after}:{}},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;setPage(null);setState(error instanceof InventoryBrowserError?error.state:"unavailable");}
 },[invalidate,nonceKey,scope,category,archived]);
 useEffect(()=>{
  const hide=()=>{invalidate();setVisible(false);setPage(null);setEditor(null);setQuery("");setNotice(null);},show=()=>{if(document.hidden)return;setVisible(true);void load();},visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  let mounted=true;document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else void load();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,load]);
 function search(event:FormEvent){event.preventDefault();void load(query);}
 if(!visible)return <div className="resource-form" data-testid="inventory-item-manager"><p role="status">{t(state==="offline"?"states.offline":"privateHidden")}</p></div>;
 return <div className="resource-form" data-testid="inventory-item-manager"><div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load()}>{t("refresh")}</button>{page?.capabilities.create&&state==="ready"&&!editor&&notice!=="unconfirmed"?<button type="button" className="primary-button" onClick={()=>setEditor({initial:null,operation:"CREATE"})}>{t("operations.CREATE")}</button>:null}</div>
  {notice?<p role="status">{t(notice)}</p>:null}
  {editor?<Editor key={editor.initial?.id??"new"} {...editor} locale={locale} scope={scope} nonceKey={nonceKey} onClose={()=>setEditor(null)} onDenied={denied} onSaved={()=>{setNotice("saved");void load(query);}} onUnknown={()=>{setNotice("unconfirmed");void load(query);}}/>:<>
   <form className="filter-bar" onSubmit={search}><div className="field"><label htmlFor={id+"search"}>{t("search")}</label><input id={id+"search"} type="search" maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="field"><label htmlFor={id+"category"}>{t("category")}</label><select id={id+"category"} value={category} onChange={event=>{setQuery("");setCategory(event.target.value);}}><option value="">{t("allCategories")}</option>{(["CONSUMABLE","LINEN","EQUIPMENT"]as const).map(value=><option key={value} value={value}>{t("categories."+value)}</option>)}</select></div><label className="checkbox-field"><input type="checkbox" checked={archived} onChange={event=>{setQuery("");setArchived(event.target.checked);}}/>{t("retired")}</label><button type="submit" className="secondary-button" disabled={state==="loading"}>{t("searchAction")}</button></form>
   {state==="loading"?<SkeletonBlock/>:state!=="ready"?<div role="alert"><p>{t("states."+state)}</p>{state!=="forbidden"?<button type="button" className="secondary-button" onClick={()=>void load(query)}>{t("retry")}</button>:null}</div>:page?.items.length?<ul className="service-catalog-list">{page.items.map(item=><li className="detail-panel" key={item.id} data-testid="inventory-item-row"><h2 dir="auto">{localizedText(item.name,locale)}</h2><p dir="auto">{item.key} · {t("categories."+item.category)} · {item.unit??t("unspecifiedUnit")}</p>{notice!=="unconfirmed"?<div className="form-actions">{page.capabilities.edit&&!item.archivedAt?<button type="button" className="secondary-button" onClick={()=>setEditor({initial:item,operation:"RENAME"})}>{t("operations.RENAME")}</button>:null}{item.archivedAt?page.capabilities.edit?<button type="button" className="secondary-button" onClick={()=>setEditor({initial:item,operation:"RESTORE"})}>{t("operations.RESTORE")}</button>:null:page.capabilities.retire?<button type="button" className="quiet-button" onClick={()=>setEditor({initial:item,operation:"ARCHIVE"})}>{t("operations.ARCHIVE")}</button>:null}</div>:null}</li>)}</ul>:<p>{t("empty")}</p>}
   {page?<div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load(query)}>{t("firstPage")}</button>{page.next?<button type="button" className="secondary-button" onClick={()=>void load(query,page.next!)}>{t("nextPage")}</button>:null}</div>:null}
  </>}
 </div>;
}
