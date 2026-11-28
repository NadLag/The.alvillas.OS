"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {inventoryLocationPageSchema,inventoryLocationRecoverySchema,type InventoryLocationView} from "../domain/location-view";
import {inventoryCatalogRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
const Editor=dynamic(()=>import("./location-editor").then(module=>module.InventoryLocationEditor),{loading:()=> <SkeletonBlock/>});
type Editing={initial:InventoryLocationView|null;operation:"CREATE"|"RENAME"|"ARCHIVE"|"RESTORE"};
export function InventoryLocationManager({locale,authorizationScope:scope}:{locale:AppLocale;authorizationScope:string}){
 const t=useTranslations("InventoryLocations"),id=useId(),nonceKey="alvillas:inventory-location:"+scope,[page,setPage]=useState<z.infer<typeof inventoryLocationPageSchema>|null>(null),[state,setState]=useState<InventoryBrowserState>("loading"),[query,setQuery]=useState(""),[kind,setKind]=useState(""),[archived,setArchived]=useState(false),[editor,setEditor]=useState<Editing|null>(null),[visible,setVisible]=useState(true),[notice,setNotice]=useState<"saved"|"unconfirmed"|"notRecorded"|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const denied=useCallback(()=>{invalidate();setPage(null);setEditor(null);setQuery("");setNotice(null);setState("forbidden");},[invalidate]);
 const load=useCallback(async(search="",after?:string)=>{
  invalidate();const own=epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setEditor(null);setState("loading");
  try{
   const nonce=readCommandNonce(nonceKey);if(nonce){const recovered=inventoryLocationRecoverySchema.parse(await inventoryCatalogRequest("locations","recover",{idempotencyKey:nonce},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;clearCommandNonce(nonceKey,nonce);setNotice(recovered.recorded?"saved":"notRecorded");}
   const value=inventoryLocationPageSchema.parse(await inventoryCatalogRequest("locations","page",{query:search,archived,...kind?{kind}:{},...after?{after}:{}},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;setPage(null);setState(error instanceof InventoryBrowserError?error.state:"unavailable");}
 },[invalidate,nonceKey,scope,kind,archived]);
 useEffect(()=>{
  const hide=()=>{invalidate();setVisible(false);setPage(null);setEditor(null);setQuery("");setNotice(null);},show=()=>{if(document.hidden)return;setVisible(true);void load();},visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  let mounted=true;document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else void load();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,load]);
 function search(event:FormEvent){event.preventDefault();void load(query);}
 if(!visible)return <div className="resource-form" data-testid="inventory-location-manager"><p role="status">{t(state==="offline"?"states.offline":"privateHidden")}</p></div>;
 return <div className="resource-form" data-testid="inventory-location-manager"><div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load()}>{t("refresh")}</button>{page?.capabilities.create&&state==="ready"&&!editor&&notice!=="unconfirmed"?<button type="button" className="primary-button" onClick={()=>setEditor({initial:null,operation:"CREATE"})}>{t("operations.CREATE")}</button>:null}</div>
  {notice?<p role="status">{t(notice)}</p>:null}
  {editor?<Editor key={editor.initial?.id??"new"} {...editor} scope={scope} nonceKey={nonceKey} onClose={()=>setEditor(null)} onDenied={denied} onSaved={()=>{setNotice("saved");void load(query);}} onUnknown={()=>{setNotice("unconfirmed");void load(query);}}/>:<>
   <form className="filter-bar" onSubmit={search}><div className="field"><label htmlFor={id+"search"}>{t("search")}</label><input id={id+"search"} type="search" maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="field"><label htmlFor={id+"kind"}>{t("kind")}</label><select id={id+"kind"} value={kind} onChange={event=>{setQuery("");setKind(event.target.value);}}><option value="">{t("allKinds")}</option>{(["PROPERTY","STORE","LAUNDRY","IN_TRANSIT"]as const).map(value=><option key={value} value={value}>{t("kinds."+value)}</option>)}</select></div><label className="checkbox-field"><input type="checkbox" checked={archived} onChange={event=>{setQuery("");setArchived(event.target.checked);}}/>{t("retired")}</label><button type="submit" className="secondary-button" disabled={state==="loading"}>{t("searchAction")}</button></form>
   {state==="loading"?<SkeletonBlock/>:state!=="ready"?<div role="alert"><p>{t("states."+state)}</p>{state!=="forbidden"?<button type="button" className="secondary-button" onClick={()=>void load(query)}>{t("retry")}</button>:null}</div>:page?.items.length?<ul className="service-catalog-list">{page.items.map(location=><li className="detail-panel" key={location.id} data-testid="inventory-location-row"><h2 dir="auto">{location.label}</h2><p>{t("kinds."+location.kind)}</p>{location.propertyId?<p><span dir="auto">{location.propertyName}</span> · <Link prefetch={false} href={"/"+locale+"/app/properties/"+location.propertyId}>{t("openProperty")}</Link></p>:null}{location.propertyArchived?<p>{t("propertyArchived")}</p>:notice!=="unconfirmed"?<div className="form-actions">{page.capabilities.edit&&!location.archivedAt?<button type="button" className="secondary-button" onClick={()=>setEditor({initial:location,operation:"RENAME"})}>{t("operations.RENAME")}</button>:null}{location.archivedAt?page.capabilities.edit?<button type="button" className="secondary-button" onClick={()=>setEditor({initial:location,operation:"RESTORE"})}>{t("operations.RESTORE")}</button>:null:page.capabilities.retire?<button type="button" className="quiet-button" onClick={()=>setEditor({initial:location,operation:"ARCHIVE"})}>{t("operations.ARCHIVE")}</button>:null}</div>:null}</li>)}</ul>:<p>{t("empty")}</p>}
   {page?<div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load(query)}>{t("firstPage")}</button>{page.next?<button type="button" className="secondary-button" onClick={()=>void load(query,page.next!)}>{t("nextPage")}</button>:null}</div>:null}
  </>}
 </div>;
}
