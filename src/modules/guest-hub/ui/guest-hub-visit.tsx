"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import {GuestHubStay} from "./guest-hub-stay";
import {SkeletonBlock} from "@/design-system/shells";
import type {AppLocale} from "@/i18n/routing";
import {guestHubPublicViewSchema,guestHubTokenTextSchema} from "../domain/guest-hub-contract";
import {guestHubRequest,GuestHubBrowserError,type GuestHubBrowserState} from "./guest-hub-browser";

type View=z.infer<typeof guestHubPublicViewSchema>;
export function GuestHubVisit({locale,initialLinkId}:{locale:AppLocale;initialLinkId?:string}){
 const t=useTranslations("GuestAccess"),[view,setView]=useState<View|null>(null),[state,setState]=useState<GuestHubBrowserState>("loading"),controller=useRef<AbortController|null>(null),epoch=useRef(0),token=useRef<string|null>(null),linkId=useRef(initialLinkId);
 // Invalidate the live request generation, including requests started by focus/visibility handlers.
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const load=useCallback(async()=>{
  if(controller.current&&!controller.current.signal.aborted)return;const selected=new AbortController();controller.current=selected;const own=++epoch.current;setView(null);setState("loading");
  try{
   const original=token.current,path=original||!linkId.current?"visit":"links/"+linkId.current+"/visit",input=original||!linkId.current?{token:original??""}:{};
   const result=guestHubPublicViewSchema.parse(await guestHubRequest(path,input,selected.signal));if(own!==epoch.current||selected.signal.aborted)return;
   if(!original&&linkId.current&&result.id!==linkId.current)throw new GuestHubBrowserError("link_unavailable");
   token.current=null;linkId.current=result.id;history.replaceState(history.state,"","/"+locale+"/guest/"+result.id);setView(result);setState("ready");
  }catch(error){if(own!==epoch.current||selected.signal.aborted)return;setView(null);setState(error instanceof GuestHubBrowserError?error.state:"unavailable");}finally{if(own===epoch.current)controller.current=null;}
 },[locale]);
 useEffect(()=>{
  const fragment=window.location.hash.slice(1);if(fragment){history.replaceState(history.state,"",window.location.pathname);const parsed=guestHubTokenTextSchema.safeParse(fragment);token.current=parsed.success?parsed.data:null;}
  void load();const focus=()=>{if(document.visibilityState==="visible")void load();},offline=()=>{invalidate();setView(null);setState("offline");},visibility=()=>{if(document.visibilityState==="hidden"){invalidate();setView(null);setState("loading");}else void load();};window.addEventListener("focus",focus);window.addEventListener("online",focus);window.addEventListener("offline",offline);document.addEventListener("visibilitychange",visibility);
  return()=>{invalidate();window.removeEventListener("focus",focus);window.removeEventListener("online",focus);window.removeEventListener("offline",offline);document.removeEventListener("visibilitychange",visibility);};
 },[load,invalidate]);
 return <section className="resource-form guest-access-record" data-testid="guest-access-record" aria-busy={state==="loading"}>
  <div aria-live="polite" data-testid="guest-access-status">{state==="loading"?<><p role="status">{t("loading")}</p><SkeletonBlock rows={2}/></>:view?<p role="status">{t("loaded")}</p>:<p role="alert">{t("states."+state)}</p>}</div>
  {view&&<GuestHubStay view={view} locale={locale} onRefresh={()=>{void load();}}/>}
  {!view&&state!=="loading"&&<button type="button" className="primary-button" onClick={()=>{void load();}} data-testid="guest-access-refresh">{t(view?"refresh":"retry")}</button>}
 </section>;
}
