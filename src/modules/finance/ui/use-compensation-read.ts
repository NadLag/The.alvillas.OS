"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import type { z } from "zod";

export type CompensationReadError="forbidden"|"offline"|"unavailable"|"validation";
/** Financial data stays in memory and is cleared before revalidation, on denied access, and on connection loss. */
export function useCompensationRead<T>(url:string,schema:z.ZodType<T>){
  const [data,setData]=useState<T|null>(null),[error,setError]=useState<CompensationReadError|null>(null),[pending,setPending]=useState(true);
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  const clear=useCallback((reason:CompensationReadError)=>{generation.current++;controller.current?.abort();setData(null);setPending(false);setError(reason);},[]);
  const refresh=useCallback(async()=>{
    const own=++generation.current;controller.current?.abort();setData(null);setError(null);setPending(true);
    if(!navigator.onLine){setError("offline");setPending(false);return;}
    const abort=new AbortController();controller.current=abort;
    try{
      const response=await fetch(url,{credentials:"same-origin",cache:"no-store",signal:abort.signal});
      if(own!==generation.current)return;
      if(!response.ok){setError(response.status===401||response.status===403?"forbidden":response.status===400?"validation":"unavailable");return;}
      const parsed=schema.safeParse(await response.json());if(own!==generation.current)return;
      if(parsed.success)setData(parsed.data);else setError("unavailable");
    }catch{if(own===generation.current)setError(navigator.onLine?"unavailable":"offline");}
    finally{if(own===generation.current)setPending(false);}
  },[url,schema]);
  useEffect(()=>{
    let disposed=false;const invalidate=()=>{generation.current++;controller.current?.abort();};
    queueMicrotask(()=>{if(!disposed)void refresh();});const offline=()=>clear("offline"),revalidate=()=>{void refresh();};
    window.addEventListener("offline",offline);window.addEventListener("online",revalidate);window.addEventListener("focus",revalidate);
    return()=>{disposed=true;invalidate();window.removeEventListener("offline",offline);window.removeEventListener("online",revalidate);window.removeEventListener("focus",revalidate);};
  },[refresh,clear]);
  return{data,error,pending,refresh,clear};
}
