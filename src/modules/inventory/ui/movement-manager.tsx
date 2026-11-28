"use client";
import dynamic from "next/dynamic";
import {useCallback,useEffect,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {inventoryMovementPageSchema,inventoryMovementRecoverySchema,type InventoryMovementHistory} from "../domain/movement-view";
import {inventoryCatalogRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
const Editor=dynamic(()=>import("./movement-editor").then(module=>module.InventoryMovementEditor),{loading:()=> <SkeletonBlock/>});
export function InventoryMovementManager({locale,authorizationScope:scope,initialGroupId}:{locale:AppLocale;authorizationScope:string;initialGroupId?:string}){
 const t=useTranslations("InventoryMovements"),nonceKey="alvillas:inventory-movement:"+scope,[page,setPage]=useState<z.infer<typeof inventoryMovementPageSchema>|null>(null),[state,setState]=useState<InventoryBrowserState>("loading"),[editor,setEditor]=useState<{original:InventoryMovementHistory|null}|null>(null),[visible,setVisible]=useState(true),[notice,setNotice]=useState<"saved"|"unconfirmed"|"notRecorded"|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const denied=useCallback(()=>{invalidate();setPage(null);setEditor(null);setNotice(null);setState("forbidden");},[invalidate]);
 const load=useCallback(async(after?:string)=>{
  invalidate();const own=epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setEditor(null);setState("loading");
  try{
   const nonce=readCommandNonce(nonceKey);if(nonce){const recovered=inventoryMovementRecoverySchema.parse(await inventoryCatalogRequest("movements","recover",{idempotencyKey:nonce},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;if(recovered.receipt&&(recovered.receipt.organizationId+"."+recovered.receipt.actorId!==scope||recovered.receipt.groupId!==nonce))throw new InventoryBrowserError("forbidden");clearCommandNonce(nonceKey,nonce);setNotice(recovered.recorded?"saved":"notRecorded");}
   const value=inventoryMovementPageSchema.parse(await inventoryCatalogRequest("movements","page",{...initialGroupId?{groupId:initialGroupId}:{},...after?{after}:{}},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;setPage(null);setState(error instanceof InventoryBrowserError?error.state:"unavailable");}
 },[invalidate,nonceKey,scope,initialGroupId]);
 useEffect(()=>{
  const hide=()=>{invalidate();setVisible(false);setPage(null);setEditor(null);setNotice(null);},show=()=>{if(document.hidden)return;setVisible(true);void load();},visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  let mounted=true;document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else void load();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,load]);
 if(!visible)return <div className="resource-form" data-testid="inventory-movement-manager"><p role="status">{t(state==="offline"?"states.offline":"privateHidden")}</p></div>;
 return <div className="resource-form" data-testid="inventory-movement-manager"><div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load()}>{t("refresh")}</button>{page?.capabilities.create&&state==="ready"&&!editor&&notice!=="unconfirmed"?<button type="button" className="primary-button" onClick={()=>setEditor({original:null})}>{t("create")}</button>:null}</div>
  {notice?<p role="status">{t(notice)}</p>:null}{editor?<Editor key={editor.original?.id??"new"} {...editor} locale={locale} scope={scope} nonceKey={nonceKey} allowAdjustment={page?.capabilities.adjust??false} onClose={()=>setEditor(null)} onDenied={denied} onSaved={()=>{setNotice("saved");void load();}} onUnknown={()=>{setNotice("unconfirmed");void load();}}/>:<>
   {state==="loading"?<SkeletonBlock/>:state!=="ready"?<div role="alert"><p>{t("states."+state)}</p>{state!=="forbidden"?<button type="button" className="secondary-button" onClick={()=>void load()}>{t("retry")}</button>:null}</div>:page?.items.length?<ul className="service-catalog-list">{page.items.map(row=><li key={row.id} className="detail-panel" data-testid="inventory-movement-row" data-movement-id={row.id}><h2 dir="auto">{localizedText(row.item.name,locale)}</h2><p>{t("kinds."+row.kind)} · <time dateTime={row.createdAt}>{new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short"}).format(new Date(row.createdAt))}</time></p><p dir="auto">{row.item.key} · {row.item.unit??t("unspecifiedUnit")}</p><div className="data-table-scroll" tabIndex={0} role="group" aria-label={localizedText(row.item.name,locale)}><table><thead><tr><th scope="col">{t("fields.location")}</th><th scope="col">{t("dimensions.quantity")}</th><th scope="col">{t("dimensions.reserved")}</th><th scope="col">{t("dimensions.damaged")}</th></tr></thead><tbody>{row.lines.map(line=><tr key={line.id}><th scope="row" dir="auto">{line.label}</th><td dir="ltr">{line.quantity}</td><td dir="ltr">{line.reserved}</td><td dir="ltr">{line.damaged}</td></tr>)}</tbody></table></div><p dir="auto">{row.reason}</p>{row.reversedBy?<p>{t("reversed")}</p>:page.capabilities.reverse&&row.kind!=="REVERSAL"&&notice!=="unconfirmed"?<button type="button" className="quiet-button" onClick={()=>setEditor({original:row})}>{t("reverse")}</button>:null}</li>)}</ul>:<p>{t("empty")}</p>}
   {page?<div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load()}>{t("firstPage")}</button>{page.next?<button type="button" className="secondary-button" onClick={()=>void load(page.next!)}>{t("nextPage")}</button>:null}</div>:null}
  </>}
 </div>;
}
