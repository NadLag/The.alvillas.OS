"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {chefTaskResponseSchema} from "../domain/chef-menu-view";
import {privateServiceRequest,ServicePrivateBrowserError,type ServicePrivateBrowserState} from "./service-catalog-browser";
import {ChefMenuRecipe,ChefOrderRequirements} from "./chef-menu-details";
type ViewModel=z.infer<typeof chefTaskResponseSchema>&{authorizationScope:string};
export function ChefTaskRecipe({locale,taskId,scope}:{locale:AppLocale;taskId:string;scope:string}){
 const t=useTranslations("ChefMenu"),states=useTranslations("ServiceOrders"),[value,setValue]=useState<ViewModel|null>(null),[state,setState]=useState<ServicePrivateBrowserState>("ready"),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const clear=useCallback(()=>{controller.current?.abort();epoch.current++;setValue(null);},[]);
 useEffect(()=>{const invalidate=()=>{clear();setState(navigator.onLine?"ready":"offline");},hide=()=>{if(document.hidden)invalidate();},offline=()=>{clear();setState("offline");},show=(event:PageTransitionEvent)=>{if(event.persisted)invalidate();};let live=true;document.addEventListener("visibilitychange",hide);window.addEventListener("offline",offline);window.addEventListener("online",invalidate);window.addEventListener("pagehide",invalidate);window.addEventListener("pageshow",show);queueMicrotask(()=>{if(live)invalidate();});return()=>{live=false;document.removeEventListener("visibilitychange",hide);window.removeEventListener("offline",offline);window.removeEventListener("online",invalidate);window.removeEventListener("pagehide",invalidate);window.removeEventListener("pageshow",show);controller.current?.abort();epoch.current++;};},[clear,scope,taskId]);
 async function load(){clear();const own=epoch.current,abort=new AbortController();controller.current=abort;setState("loading");try{const result=chefTaskResponseSchema.parse(await privateServiceRequest("orders","chefTask",{taskId},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current||document.hidden)return;if(result.taskId!==taskId)throw new ServicePrivateBrowserError("uncertain");setValue({...result,authorizationScope:scope});setState("ready");}catch(error){if(abort.signal.aborted||own!==epoch.current)return;setValue(null);setState(error instanceof ServicePrivateBrowserError?error.state:"unavailable");}}
 const visible=value?.taskId===taskId&&value.authorizationScope===scope?value:null;
 return<section className="panel" data-testid="chef-task-recipe"><h2>{t("taskRecipe")}</h2><button type="button" className="secondary-button" disabled={state==="loading"||state==="offline"} onClick={()=>void load()}>{t(visible?"refreshRecipe":"readRecipe")}</button>{state!=="ready"?<p role={state==="loading"||state==="offline"?"status":"alert"}>{states("states."+state)}</p>:null}{visible?<article><h3 dir="auto">{localizedText(visible.name,locale)}</h3><p dir="auto">{localizedText(visible.description,locale)}</p><ChefMenuRecipe locale={locale} menu={visible.menu}/><ChefOrderRequirements locale={locale} requirements={visible.requirements}/></article>:null}</section>;
}
