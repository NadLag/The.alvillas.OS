"use client";
import dynamic from "next/dynamic";
import {useCallback,useEffect,useId,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {serviceOrderStates} from "../domain/service-order-contracts";
import {serviceOrderPageResponseSchema,serviceOrderRecoveryResponseSchema,type serviceOrderMetadataSchema} from "../domain/service-order-view";
import {privateServiceRequest,ServicePrivateBrowserError,type ServicePrivateBrowserState} from "./service-catalog-browser";

const Editor=dynamic(()=>import("./service-order-editor").then(module=>module.ServiceOrderEditor),{loading:()=> <SkeletonBlock/>});
const Detail=dynamic(()=>import("./service-order-detail").then(module=>module.ServiceOrderDetail),{loading:()=> <SkeletonBlock/>});
type Props={locale:AppLocale;timezone:string;propertyId:string;authorizationScope:string};
export function ServiceOrderManager({locale,timezone,propertyId,authorizationScope}:Props){
 const t=useTranslations("ServiceOrders"),id=useId(),[page,setPage]=useState<z.infer<typeof serviceOrderPageResponseSchema>|null>(null),[state,setState]=useState<ServicePrivateBrowserState>("loading"),[filter,setFilter]=useState(""),[editor,setEditor]=useState(false),[selected,setSelected]=useState<z.infer<typeof serviceOrderMetadataSchema>|null>(null),[visible,setVisible]=useState(true),[notice,setNotice]=useState<"saved"|"unconfirmed"|"privateDenied"|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0),nonceKey="alvillas:service-order:"+authorizationScope+":"+propertyId;
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const load=useCallback(async(selectedFilter="",after?:string)=>{
  invalidate();const own=epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setEditor(false);setSelected(null);setState("loading");
  try{
   const nonce=readCommandNonce(nonceKey);if(nonce){const recovered=serviceOrderRecoveryResponseSchema.parse(await privateServiceRequest("orders","recover",{propertyId,idempotencyKey:nonce},abort.signal,authorizationScope));if(abort.signal.aborted||own!==epoch.current)return;if(recovered.recorded){clearCommandNonce(nonceKey,nonce);setNotice("saved");}else setNotice("unconfirmed");}
   const value=serviceOrderPageResponseSchema.parse(await privateServiceRequest("orders","page",{propertyId,...selectedFilter?{state:selectedFilter}:{},...after?{after}:{}},abort.signal,authorizationScope));if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;setPage(null);setState(error instanceof ServicePrivateBrowserError?error.state:"unavailable");}
 },[invalidate,nonceKey,propertyId,authorizationScope]);
 const privateDenied=useCallback(()=>{setNotice("privateDenied");void load();},[load]);
 useEffect(()=>{
  const hide=()=>{invalidate();setVisible(false);setPage(null);setEditor(false);setSelected(null);setFilter("");setNotice(null);},show=()=>{if(document.hidden)return;setVisible(true);void load();},visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  let mounted=true;document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else void load();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,load]);
 if(!visible)return<p role="status" data-testid="service-order-private-status">{t(state==="offline"?"states.offline":"privateHidden")}</p>;
 return<div className="service-catalog" data-testid="service-order-manager">
  <div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load(filter)}>{t("refresh")}</button>{state==="ready"&&!editor&&!selected?<button type="button" className="primary-button" onClick={()=>{setNotice(null);setEditor(true);}}>{t("add")}</button>:null}</div>
  {notice?<p role="status">{t(notice)}</p>:null}
  {editor?<Editor locale={locale} propertyId={propertyId} authorizationScope={authorizationScope} nonceKey={nonceKey} onClose={()=>setEditor(false)} onDenied={privateDenied} onSaved={()=>{setNotice("saved");void load(filter);}}/>:selected?<Detail key={selected.id} locale={locale} timezone={timezone} propertyId={propertyId} authorizationScope={authorizationScope} nonceKey={nonceKey} metadata={selected} onClose={()=>setSelected(null)} onDenied={privateDenied} onSaved={()=>{setNotice("saved");void load(filter);}}/>:<>
   <form className="filter-bar" onSubmit={event=>{event.preventDefault();void load(filter);}}><div className="field"><label htmlFor={id}>{t("fields.state")}</label><select id={id} value={filter} onChange={event=>setFilter(event.target.value)}><option value="">{t("allStates")}</option>{serviceOrderStates.map(value=><option key={value} value={value}>{t("orderStates."+value)}</option>)}</select></div><button className="secondary-button" disabled={state==="loading"}>{t("filter")}</button></form>
   {state==="loading"?<SkeletonBlock/>:state!=="ready"?<div role="alert"><p>{t("states."+state)}</p>{state!=="forbidden"?<button type="button" className="secondary-button" onClick={()=>void load(filter)}>{t("retry")}</button>:null}</div>:page?.items.length?<ul className="service-catalog-list">{page.items.map(item=><li key={item.id} className="detail-panel"><h2>{localizedText(item.title,locale)}</h2><p>{t("orderStates."+item.state)}</p><p dir="auto">{item.serviceDate} – {item.lastServiceDate}</p><p>{t("dimensions",{quantity:item.quantity,guests:item.guests})}</p><button type="button" className="secondary-button" onClick={()=>setSelected(item)}>{t("open")}</button></li>)}</ul>:<p>{t("empty")}</p>}
   {page?<div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load(filter)}>{t("firstPage")}</button>{page.next?<button type="button" className="secondary-button" onClick={()=>void load(filter,page.next!)}>{t("nextPage")}</button>:null}</div>:null}
  </>}
 </div>;
}
