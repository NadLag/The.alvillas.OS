"use client";
import {useCallback,useEffect,useId,useRef,useState} from "react";
import {useTranslations} from "next-intl";
import {teamScopeChoicesAction} from "../application/team-actions";
import {teamScopeChoiceResult,type teamScopeChoicePage} from "../domain/team-scope-choices";
import type {z} from "zod";
type Page=z.infer<typeof teamScopeChoicePage>;
const empty:Page={items:[],next:null};
export function TeamScopePicker({type}:{type:"property"|"region"|"city"}){
 const t=useTranslations("Team"),id=useId();
 const [query,setQuery]=useState("");
 const [selected,setSelected]=useState("");
 const [data,setData]=useState<Page>(empty);
 const [cursor,setCursor]=useState<string|null>(null);
 const [status,setStatus]=useState<"loading"|"ready"|"offline"|"invalid"|"denied"|"unavailable">("loading");
 const generation=useRef(0),retainedQuery=useRef("");
 const invalidate=useCallback(()=>{generation.current++;},[]);
 const load=useCallback(async(query:string,after?:string)=>{
  const own=++generation.current;retainedQuery.current=query;setSelected("");setData(empty);setCursor(after??null);
  if(!navigator.onLine){setStatus("offline");return;}setStatus("loading");
  try{const response=teamScopeChoiceResult.parse(await teamScopeChoicesAction({type,query,...after?{after}:{}}));if(own!==generation.current)return;if(response.status==="ready"){setData(response.data);setStatus("ready");}else setStatus(response.status);}
  catch{if(own===generation.current)setStatus(navigator.onLine?"unavailable":"offline");}
 },[type]);
 useEffect(()=>{let disposed=false;queueMicrotask(()=>{if(!disposed)void load("");});const offline=()=>{invalidate();setData(empty);setSelected("");setStatus("offline");},online=()=>{void load(retainedQuery.current);};window.addEventListener("offline",offline);window.addEventListener("online",online);return()=>{disposed=true;invalidate();window.removeEventListener("offline",offline);window.removeEventListener("online",online);};},[invalidate,load]);
 return <div className="team-scope-picker" aria-busy={status==="loading"}>
  <div className="team-field"><label htmlFor={id+"-query"}>{t("scopeChoices.searchLabel")}</label><input id={id+"-query"} type="search" maxLength={120} dir="auto" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void load(query);}}} data-testid="team-scope-query"/></div>
  <button type="button" className="secondary-button" disabled={status==="loading"||status==="offline"} onClick={()=>{void load(query);}} data-testid="team-scope-search">{t("scopeChoices.search")}</button>
  <div className="team-field"><label htmlFor={id+"-record"}>{t("fields.scopeId")}</label><select id={id+"-record"} name="scopeId" required value={selected} disabled={status!=="ready"} onChange={event=>setSelected(event.target.value)} data-testid="team-scope-record"><option value="">{t("scopeChoices.choose")}</option>{data.items.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></div>
  {status!=="ready"?<p role={status==="loading"||status==="offline"?"status":"alert"}>{t(`scopeChoices.${status}`)}</p>:!data.items.length?<p role="status">{t("scopeChoices.empty")}</p>:null}
  <div className="app-actions">{cursor?<button type="button" className="secondary-button" disabled={status==="loading"||status==="offline"} onClick={()=>{void load(retainedQuery.current);}}>{t("scopeChoices.first")}</button>:null}{data.next?<button type="button" className="secondary-button" onClick={()=>{void load(retainedQuery.current,data.next!);}} data-testid="team-scope-next">{t("scopeChoices.next")}</button>:null}{status!=="ready"&&status!=="loading"&&status!=="offline"?<button type="button" className="secondary-button" onClick={()=>{void load(retainedQuery.current,cursor??undefined);}}>{t("scopeChoices.retry")}</button>:null}</div>
 </div>;
}
