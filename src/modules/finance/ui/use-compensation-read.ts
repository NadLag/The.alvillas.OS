"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import type { z } from "zod";

export type CompensationReadError="forbidden"|"offline"|"unavailable"|"validation"|"configuration_unavailable";
/** Financial data stays in memory and is cleared before revalidation, on denied access, and on connection loss. */
export function useCompensationRead<T>(url:string|null,schema:z.ZodType<T>,onInvalidate?:()=>void){
  const [data,setData]=useState<T|null>(null),[error,setError]=useState<CompensationReadError|null>(null),[pending,setPending]=useState(true);
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  const clear=useCallback((reason:CompensationReadError)=>{generation.current++;controller.current?.abort();setData(null);setPending(false);setError(reason);onInvalidate?.();},[onInvalidate]);
  const refresh=useCallback(async()=>{
    const own=++generation.current;controller.current?.abort();setData(null);setError(null);setPending(true);
    if(!url){setPending(false);return;}
    if(!navigator.onLine){setError("offline");setPending(false);onInvalidate?.();return;}
    const abort=new AbortController();controller.current=abort;
    try{
      const response=await fetch(url,{credentials:"same-origin",cache:"no-store",signal:abort.signal});
      if(own!==generation.current)return;
      if(!response.ok){
        if(response.status===401||response.status===403){onInvalidate?.();setError("forbidden");}
        else if(response.status===400)setError("validation");
        else if(response.status===409){const body:unknown=await response.json();if(own!==generation.current)return;setError(body&&typeof body==="object"&&"error" in body&&body.error==="configuration_unavailable"?"configuration_unavailable":"unavailable");}
        else setError("unavailable");return;
      }
      const parsed=schema.safeParse(await response.json());if(own!==generation.current)return;
      if(parsed.success)setData(parsed.data);else setError("unavailable");
    }catch{if(own===generation.current)setError(navigator.onLine?"unavailable":"offline");}
    finally{if(own===generation.current)setPending(false);}
  },[url,schema,onInvalidate]);
  useEffect(()=>{
    let disposed=false;const invalidate=()=>{generation.current++;controller.current?.abort();};
    queueMicrotask(()=>{if(!disposed)void refresh();});const offline=()=>clear("offline"),revalidate=()=>{void refresh();};
    window.addEventListener("offline",offline);window.addEventListener("online",revalidate);window.addEventListener("focus",revalidate);
    return()=>{disposed=true;invalidate();window.removeEventListener("offline",offline);window.removeEventListener("online",revalidate);window.removeEventListener("focus",revalidate);};
  },[refresh,clear]);
  return{data,error,pending,refresh,clear};
}
