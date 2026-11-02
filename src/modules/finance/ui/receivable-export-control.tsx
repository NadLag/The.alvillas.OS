"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {receivableExportInput} from "../domain/receivable-export";

export function ReceivableExportControl({locale,currency,bucket,search,onDenied,onStart}:{locale:AppLocale;currency:string;bucket:string;search:string;onDenied:()=>void;onStart:()=>void}){
 const t=useTranslations("ReceivableExports"),[reason,setReason]=useState(""),[state,setState]=useState<"ready"|"sending"|"success"|"validation"|"offline"|"configuration"|"rateLimited"|"unavailable">("ready"),controller=useRef<AbortController|null>(null),downloadUrl=useRef<string|null>(null);
 useEffect(()=>()=>{controller.current?.abort();if(downloadUrl.current)URL.revokeObjectURL(downloadUrl.current);},[]);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const input=receivableExportInput.safeParse({query:{currency,search,...bucket?{bucket}:{}},locale,reason});if(!input.success){setState("validation");return;}if(!navigator.onLine){setReason("");setState("offline");return;}
  const abort=new AbortController();controller.current?.abort();controller.current=abort;setState("sending");onStart();
  try{const response=await fetch("/api/finance/receivables/export",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(input.data),signal:abort.signal});if(abort.signal.aborted)return;
   if(response.status===401||response.status===403){setReason("");onDenied();return;}
   if(response.status===429){setState("rateLimited");return;}
   if(!response.ok){const failure:unknown=await response.json();setState(response.status===400?"validation":response.status===409&&failure&&typeof failure==="object"&&"error" in failure&&failure.error==="configuration_unavailable"?"configuration":"unavailable");return;}
   if(!response.headers.get("content-type")?.startsWith("text/csv")){setState("unavailable");return;}
   const blob=await response.blob();if(abort.signal.aborted)return;const disposition=response.headers.get("content-disposition")??"",encoded=/filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1],fallback=/filename="([^"]+)"/u.exec(disposition)?.[1],name=encoded?decodeURIComponent(encoded):fallback;
   if(!name||/[\\/]/u.test(name)||!name.endsWith(".csv")){setState("unavailable");return;}
   if(downloadUrl.current)URL.revokeObjectURL(downloadUrl.current);const url=URL.createObjectURL(blob);downloadUrl.current=url;const link=document.createElement("a");link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setReason("");setState("success");setTimeout(()=>{URL.revokeObjectURL(url);if(downloadUrl.current===url)downloadUrl.current=null;},1000);
  }catch{if(!abort.signal.aborted)setState(navigator.onLine?"unavailable":"offline");}finally{if(controller.current===abort)controller.current=null;}
 }
 return <form className="resource-form" onSubmit={event=>{void submit(event);}} aria-label={t("title")} data-testid="receivable-export-control"><h3>{t("title")}</h3><p>{t("guidance")}</p><label className="field"><span>{t("reason")}</span><textarea value={reason} minLength={6} maxLength={1000} required disabled={state==="sending"} dir="auto" onChange={event=>{setReason(event.target.value);setState("ready");}} data-testid="receivable-export-reason"/></label><button className="secondary-button" type="submit" disabled={state==="sending"||state==="offline"} data-testid="receivable-export-submit">{t(state==="sending"?"sending":"submit")}</button>{state!=="ready"&&state!=="sending"?<p role={state==="success"||state==="offline"?"status":"alert"} data-testid="receivable-export-result">{t(state)}</p>:null}</form>;
}
