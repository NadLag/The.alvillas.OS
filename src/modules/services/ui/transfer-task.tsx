"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {transferTaskResponseSchema} from "@/platform/services/transfer-task-contracts";
import {TransferDetails} from "./transfer-details";
import {privateServiceRequest,ServicePrivateBrowserError,type ServicePrivateBrowserState} from "./service-catalog-browser";
export function TransferTask({locale,taskId,scope}:{locale:AppLocale;taskId:string;scope:string}){
 const t=useTranslations("ServiceOrders"),[value,setValue]=useState<(z.infer<typeof transferTaskResponseSchema>&{scope:string})|null>(null),[state,setState]=useState<ServicePrivateBrowserState>("ready"),controller=useRef<AbortController|null>(null),epoch=useRef(0),[known,setKnown]=useState(false);
 const cancel=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const clear=useCallback(()=>{cancel();setValue(null);},[cancel]);
 const load=useCallback(async()=>{clear();const own=epoch.current,abort=new AbortController();controller.current=abort;setState(navigator.onLine?"loading":"offline");if(!navigator.onLine)return;try{const result=transferTaskResponseSchema.parse(await privateServiceRequest("orders","transferTask",{taskId},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current||document.hidden)return;if(result.taskId!==taskId)throw new ServicePrivateBrowserError("uncertain");setKnown(result.available);setValue({...result,scope});setState("ready");}catch(error){if(abort.signal.aborted||own!==epoch.current)return;setState(error instanceof ServicePrivateBrowserError?error.state:"unavailable");}},[clear,scope,taskId]);
 useEffect(()=>{const hide=()=>{clear();setState(navigator.onLine?"ready":"offline");},show=()=>{if(!document.hidden)void load();},visibility=()=>document.hidden?hide():show(),restore=(event:PageTransitionEvent)=>{if(event.persisted)show();};let live=true;queueMicrotask(()=>{if(live){setKnown(false);show();}});document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",restore);window.addEventListener("offline",hide);window.addEventListener("online",show);return()=>{live=false;cancel();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",restore);window.removeEventListener("offline",hide);window.removeEventListener("online",show);};},[cancel,clear,load]);
 const current=value?.scope===scope&&value.taskId===taskId?value:null;
 return current?.available?<TransferDetails locale={locale} transfer={current.transfer} date={current.date} timezone={current.timezone} guests={current.guests}/>:known&&state!=="ready"?<p role="status">{t("states."+state)}</p>:null;
}
