"use client";
import dynamic from "next/dynamic";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {formatCurrencyAmount} from "@/i18n/format";
import {SkeletonBlock} from "@/design-system/shells";
import {readCommandNonce,clearCommandNonce} from "@/platform/http/command-nonce";
import {serviceCatalogPageResponseSchema,serviceCatalogRecoveryResponseSchema,type ServiceCatalogItem} from "../domain/service-catalog-view";
import {serviceCatalogRequest,ServiceCatalogBrowserError,type ServiceCatalogBrowserState} from "./service-catalog-browser";

const Editor=dynamic(()=>import("./service-catalog-editor").then(module=>module.ServiceCatalogEditor),{loading:()=> <SkeletonBlock/>});
const History=dynamic(()=>import("./service-catalog-history").then(module=>module.ServiceCatalogHistory),{loading:()=> <SkeletonBlock/>});
type Props={locale:AppLocale;timezone:string;propertyId:string;authorizationScope:string;canConfigure:boolean};
export function ServiceCatalogManager({locale,timezone,propertyId,authorizationScope,canConfigure}:Props){
 const t=useTranslations("ServiceCatalog"),id=useId(),[page,setPage]=useState<z.infer<typeof serviceCatalogPageResponseSchema>|null>(null),[state,setState]=useState<ServiceCatalogBrowserState>("loading"),[query,setQuery]=useState(""),[editor,setEditor]=useState<{item:ServiceCatalogItem|null}|null>(null),[history,setHistory]=useState(false),[visible,setVisible]=useState(true),[notice,setNotice]=useState<"saved"|"unconfirmed"|null>(null),controller=useRef<AbortController|null>(null),epoch=useRef(0),nonceKey="alvillas:service-catalog:"+authorizationScope+":"+propertyId;
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const denied=useCallback(()=>{invalidate();setPage(null);setEditor(null);setHistory(false);setQuery("");setNotice(null);setState("forbidden");},[invalidate]);
 const load=useCallback(async(search="",after?:string)=>{
  invalidate();const own=epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setEditor(null);setState("loading");
  try{
   const original=readCommandNonce(nonceKey);if(original&&canConfigure){const recovered=serviceCatalogRecoveryResponseSchema.parse(await serviceCatalogRequest("recover",{scope:{propertyId},idempotencyKey:original},abort.signal,authorizationScope));if(recovered.propertyId!==propertyId||recovered.idempotencyKey!==original)throw new ServiceCatalogBrowserError("uncertain");if(abort.signal.aborted||own!==epoch.current)return;if(recovered.recorded){clearCommandNonce(nonceKey,original);setNotice("saved");}else setNotice("unconfirmed");}
   const value=serviceCatalogPageResponseSchema.parse(await serviceCatalogRequest("page",{scope:{propertyId},query:search,...after?{after}:{}},abort.signal,authorizationScope));if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;setPage(null);setState(error instanceof ServiceCatalogBrowserError?error.state:"unavailable");}
 },[invalidate,nonceKey,canConfigure,propertyId,authorizationScope]);
 useEffect(()=>{
  const hide=()=>{invalidate();setVisible(false);setPage(null);setEditor(null);setHistory(false);setQuery("");setNotice(null);},show=()=>{if(document.hidden)return;setVisible(true);void load();},visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  let mounted=true;document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else void load();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,load]);
 function search(event:FormEvent){event.preventDefault();setHistory(false);void load(query);}
 if(!visible)return<p role="status">{t(state==="offline"?"states.offline":"privateHidden")}</p>;
 return<div className="service-catalog" data-testid="service-catalog-manager">
  <div className="form-actions"><button type="button" className="quiet-button" onClick={()=>{setEditor(null);setHistory(value=>!value);}}>{t(history?"catalog":"history")}</button><button type="button" className="quiet-button" onClick={()=>{setHistory(false);setNotice(null);void load();}}>{t("refresh")}</button>{canConfigure&&!history&&state==="ready"?<button className="primary-button" type="button" onClick={()=>setEditor({item:null})}>{t("add")}</button>:null}</div>
  {notice?<p role="status">{t(notice)}</p>:null}
  {history?<History locale={locale} timezone={timezone} propertyId={propertyId} authorizationScope={authorizationScope} onDenied={denied}/>:editor?<Editor key={editor.item?.key??"new"} locale={locale} propertyId={propertyId} authorizationScope={authorizationScope} nonceKey={nonceKey} initial={editor.item} onDenied={denied} onClose={()=>setEditor(null)} onSaved={()=>{setNotice("saved");void load(query);}}/>:<>
   <form className="filter-bar" onSubmit={search}><div className="field"><label htmlFor={id}>{t("search")}</label><input id={id} type="search" maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/></div><button className="secondary-button" type="submit" disabled={state==="loading"}>{t("searchAction")}</button></form>
   {state==="loading"?<SkeletonBlock/>:state!=="ready"?<div role="alert"><p>{t("states."+state)}</p>{state!=="forbidden"?<button type="button" className="secondary-button" onClick={()=>void load(query)}>{t("retry")}</button>:null}</div>:page?.items.length?<ul className="service-catalog-list">{page.items.map(item=><li key={item.key} className="detail-panel"><div><h2>{item.name?localizedText(item.name,locale):item.key}</h2><p className="muted-copy">{item.description?localizedText(item.description,locale):t("noDescription")}</p><p>{t("models."+item.pricingModel)} · <span className="money" dir="auto">{item.amount&&item.currency?formatCurrencyAmount(locale,item.amount,item.currency):t("quoteRequired")}</span></p><p>{t(item.available===true?"available":"unavailable")}{item.orderTerms?" · "+t("termsConfigured"):" · "+t("termsMissing")}</p></div>{canConfigure?<button className="secondary-button" type="button" onClick={()=>setEditor({item})}>{t("edit")}</button>:null}</li>)}</ul>:<p>{t("empty")}</p>}
   {page?<div className="form-actions"><button className="quiet-button" type="button" onClick={()=>void load(query)}>{t("firstPage")}</button>{page.next?<button className="secondary-button" type="button" onClick={()=>void load(query,page.next!)}>{t("nextPage")}</button>:null}</div>:null}
  </>}
 </div>;
}
