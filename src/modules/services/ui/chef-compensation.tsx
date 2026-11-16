"use client";
import Link from "next/link";
import {useCallback,useEffect,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {chefCompensationContextSchema} from "../domain/chef-compensation";
import {privateServiceRequest,ServicePrivateBrowserError,type ServicePrivateBrowserState} from "./service-catalog-browser";
export function ChefCompensation({locale,orderId,scope}:{locale:AppLocale;orderId:string;scope:string}){
 const t=useTranslations("ChefCompensation"),states=useTranslations("ServiceOrders"),[value,setValue]=useState<(z.infer<typeof chefCompensationContextSchema>&{scope:string})|null>(null),[state,setState]=useState<ServicePrivateBrowserState>("ready"),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const cancel=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const clear=useCallback(()=>{cancel();setValue(null);setState(navigator.onLine?"ready":"offline");},[cancel]);
 useEffect(()=>{const hide=()=>{if(document.hidden)clear();},restore=(event:PageTransitionEvent)=>{if(event.persisted)clear();};let live=true;document.addEventListener("visibilitychange",hide);window.addEventListener("pagehide",clear);window.addEventListener("pageshow",restore);window.addEventListener("offline",clear);window.addEventListener("online",clear);queueMicrotask(()=>{if(live)clear();});return()=>{live=false;cancel();document.removeEventListener("visibilitychange",hide);window.removeEventListener("pagehide",clear);window.removeEventListener("pageshow",restore);window.removeEventListener("offline",clear);window.removeEventListener("online",clear);};},[clear,cancel,scope,orderId]);
 async function load(){clear();const own=epoch.current,abort=new AbortController();controller.current=abort;setState("loading");try{const result=chefCompensationContextSchema.parse(await privateServiceRequest("orders","chefCompensation",{orderId},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current||document.hidden)return;if(result.orderId!==orderId)throw new ServicePrivateBrowserError("uncertain");setValue({...result,scope});setState("ready");}catch(error){if(abort.signal.aborted||own!==epoch.current)return;setValue(null);setState(error instanceof ServicePrivateBrowserError?error.state:"unavailable");}}
 const current=value?.scope===scope&&value.orderId===orderId?value:null;
 return<section className="panel" data-testid="chef-compensation"><h3>{t("title")}</h3><p>{t("help")}</p><button type="button" className="secondary-button" disabled={state==="loading"||state==="offline"} onClick={()=>void load()}>{t(current?"refresh":"read")}</button>{state!=="ready"?<p role={state==="loading"||state==="offline"?"status":"alert"}>{states("states."+state)}</p>:null}{current?<div><p>{t("rules")}</p><Link className="secondary-button" prefetch={false} href={`/${locale}/app/team/${current.personId}`}>{t(current.canConfigure?"configure":"contracts")}</Link>{current.canViewPayables?<Link className="secondary-button" prefetch={false} href={`/${locale}/app/finance/compensation`}>{t("payables")}</Link>:null}<p>{t("earned")}</p></div>:null}</section>;
}
