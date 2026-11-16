"use client";
import dynamic from "next/dynamic";
import {useCallback,useEffect,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {formatCurrencyAmount} from "@/i18n/format";
import {SkeletonBlock} from "@/design-system/shells";
import {serviceOrderFinancialPageSchema} from "../domain/service-order-view";
import {privateServiceRequest,ServicePrivateBrowserError,type ServicePrivateBrowserState} from "./service-catalog-browser";
const Workspace=dynamic(()=>import("@/platform/services/order-financial-workspace").then(module=>module.NativeServiceOrderFinancialWorkspace),{loading:()=> <SkeletonBlock/>});
export function ServiceOrderFinancial({locale,orderId,propertyId,taskId,authorizationScope,onDenied}:{locale:AppLocale;orderId:string;propertyId:string;taskId:string|null;authorizationScope:string;onDenied:()=>void}){
 const t=useTranslations("ServiceOrders"),[page,setPage]=useState<z.infer<typeof serviceOrderFinancialPageSchema>|null>(null),[state,setState]=useState<ServicePrivateBrowserState>("loading"),[workspace,setWorkspace]=useState(false),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]),denied=useCallback(()=>{invalidate();setPage(null);setWorkspace(false);setState("forbidden");onDenied();},[invalidate,onDenied]);
 const load=useCallback(async(after?:string)=>{invalidate();const own=epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setWorkspace(false);setState("loading");try{const result=serviceOrderFinancialPageSchema.parse(await privateServiceRequest("orders","financial",{orderId,...after?{after}:{}},abort.signal,authorizationScope));if(abort.signal.aborted||own!==epoch.current)return;if(result.orderId!==orderId)throw new ServicePrivateBrowserError("uncertain");setPage(result);setState("ready");}catch(error){if(abort.signal.aborted||own!==epoch.current)return;const next=error instanceof ServicePrivateBrowserError?error.state:"unavailable";setState(next);if(next==="forbidden")denied();}},[invalidate,orderId,authorizationScope,denied]);
 useEffect(()=>{let mounted=true;queueMicrotask(()=>{if(mounted)void load();});return()=>{mounted=false;invalidate();};},[load,invalidate]);
 return<section className="detail-panel" aria-label={t("financial.title")} data-testid="service-order-financial"><h3>{t("financial.title")}</h3><p>{t("financial.description")}</p><div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load()}>{t("refresh")}</button>{taskId&&state==="ready"?<button type="button" className="secondary-button" onClick={()=>setWorkspace(value=>!value)}>{t(workspace?"financial.closeWorkspace":"financial.manage")}</button>:null}</div>
  {state==="loading"?<SkeletonBlock/>:state!=="ready"?<p role="alert">{t("states."+state)}</p>:page?<><h4>{t("financial.pageTotals")}</h4>{page.pageTotals.recognized?<dl className="detail-grid">{(["gross","companyRevenue","providerCost","ownerAmount","taxAmount","margin"]as const).map(key=><div key={key}><dt>{t("financial."+key)}</dt><dd className="money" dir="auto">{formatCurrencyAmount(locale,page.pageTotals[key],page.currency)}</dd></div>)}</dl>:<p>{t("financial.noRecognition")}</p>}<ul className="service-catalog-list">{page.items.map(item=><li key={item.sourceId}><p>{t(item.postingId?"financial.recognized":"financial.awaitingRecognition")}</p>{item.amounts?<p className="money" dir="auto">{t("financial.margin")} · {formatCurrencyAmount(locale,item.amounts.margin,page.currency)}</p>:null}</li>)}</ul><div className="form-actions"><button className="quiet-button" type="button" onClick={()=>void load()}>{t("firstPage")}</button>{page.next?<button className="secondary-button" type="button" onClick={()=>void load(page.next!)}>{t("nextPage")}</button>:null}</div></>:null}
  {workspace&&taskId?<Workspace locale={locale} authorizationScope={authorizationScope} propertyId={propertyId} taskId={taskId} onInvalidate={denied}/>:null}
 </section>;
}
