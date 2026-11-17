"use client";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import {inventoryLocationPropertiesSchema} from "../domain/location-view";
import {inventoryCatalogRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
export function InventoryLocationPropertyPicker({scope,onSelect,onClose,onDenied}:{scope:string;onSelect:(value:{id:string;name:string})=>void;onClose:()=>void;onDenied:()=>void}){
 const t=useTranslations("InventoryLocations"),id=useId(),[query,setQuery]=useState(""),[page,setPage]=useState<z.infer<typeof inventoryLocationPropertiesSchema>|null>(null),[state,setState]=useState<InventoryBrowserState>("loading"),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const load=useCallback(async(search="",after?:string)=>{
  controller.current?.abort();const own=++epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setState("loading");
  try{const value=inventoryLocationPropertiesSchema.parse(await inventoryCatalogRequest("locations","properties",{query:search,...after?{after}:{}},abort.signal,scope));if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");}
  catch(error){if(abort.signal.aborted||own!==epoch.current)return;if(error instanceof InventoryBrowserError&&error.state==="forbidden"){onDenied();return;}setState(error instanceof InventoryBrowserError?error.state:"unavailable");}
 },[scope,onDenied]);
 useEffect(()=>{let mounted=true;queueMicrotask(()=>{if(mounted)void load();});return()=>{mounted=false;invalidate();};},[load,invalidate]);
 function search(event:FormEvent){event.preventDefault();void load(query);}
 return <section className="detail-panel resource-form" data-testid="inventory-location-property-picker"><h3>{t("chooseProperty")}</h3><form className="filter-bar" onSubmit={search}><div className="field"><label htmlFor={id}>{t("propertySearch")}</label><input id={id} maxLength={100} type="search" value={query} onChange={event=>setQuery(event.target.value)}/></div><button type="submit" className="secondary-button" disabled={state==="loading"}>{t("searchAction")}</button></form>{state==="ready"?page?.items.length?<ul className="service-catalog-list">{page.items.map(value=><li key={value.id}><button type="button" className="secondary-button" onClick={()=>onSelect(value)}><span dir="auto">{value.name}</span></button></li>)}</ul>:<p>{t("noProperties")}</p>:<p role="status">{t("states."+state)}</p>}<div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load(query)}>{t("refresh")}</button>{page?.next?<button type="button" className="secondary-button" onClick={()=>void load(query,page.next!)}>{t("nextPage")}</button>:null}<button type="button" className="quiet-button" onClick={onClose}>{t("close")}</button></div></section>;
}
