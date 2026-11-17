"use client";
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {inventoryItemPageSchema} from "../domain/item-view";
import {inventoryLocationPageSchema} from "../domain/location-view";
import {inventoryMovementReservationChoicesSchema} from "../domain/movement-view";
import {inventoryCatalogRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
export type InventoryMovementChoice={id:string;label:string;unit?:string|null};
type Props={scope:string;locale:AppLocale;kind:"items"|"locations"|"reservations";activeReservation:boolean;allowRetired?:boolean;onSelect:(value:InventoryMovementChoice)=>void;onClose:()=>void;onDenied:()=>void};
export function InventoryMovementSourcePicker({scope,locale,kind,activeReservation,allowRetired=false,onSelect,onClose,onDenied}:Props){
 const t=useTranslations("InventoryMovements"),id=useId(),[query,setQuery]=useState(""),[archived,setArchived]=useState(false),[page,setPage]=useState<{items:InventoryMovementChoice[];next:string|null}|null>(null),[state,setState]=useState<InventoryBrowserState>("loading"),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const load=useCallback(async(search="",after?:string)=>{
  controller.current?.abort();const own=++epoch.current,abort=new AbortController();controller.current=abort;setPage(null);setState("loading");
  try{
   let value:{items:InventoryMovementChoice[];next:string|null};
   if(kind==="items"){const result=inventoryItemPageSchema.parse(await inventoryCatalogRequest("items","page",{query:search,archived,...after?{after}:{}},abort.signal,scope));value={items:result.items.map(row=>({id:row.id,label:localizedText(row.name,locale)+" · "+row.key,unit:row.unit})),next:result.next};}
   else if(kind==="locations"){const result=inventoryLocationPageSchema.parse(await inventoryCatalogRequest("locations","page",{query:search,archived,...after?{after}:{}},abort.signal,scope));value={items:result.items.filter(row=>allowRetired||!row.propertyArchived).map(row=>({id:row.id,label:row.label})),next:result.next};}
   else value=inventoryMovementReservationChoicesSchema.parse(await inventoryCatalogRequest("movements","reservations",{query:search,active:activeReservation,...after?{after}:{}},abort.signal,scope));
   if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;if(error instanceof InventoryBrowserError&&error.state==="forbidden"){onDenied();return;}setState(error instanceof InventoryBrowserError?error.state:"unavailable");}
 },[scope,locale,kind,activeReservation,onDenied,archived,allowRetired]);
 useEffect(()=>{let mounted=true;queueMicrotask(()=>{if(mounted)void load();});return()=>{mounted=false;invalidate();};},[load,invalidate]);
 function search(event:FormEvent){event.preventDefault();void load(query);}
 return <section className="detail-panel resource-form" data-testid="inventory-movement-source-picker"><h3>{t("choices."+kind)}</h3><form className="filter-bar" onSubmit={search}><div className="field"><label htmlFor={id}>{t("search")}</label><input id={id} type="search" maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/></div>{allowRetired&&kind!=="reservations"?<label className="checkbox-field"><input type="checkbox" checked={archived} onChange={event=>{setQuery("");setArchived(event.target.checked);}}/>{t("browseRetired")}</label>:null}<button type="submit" className="secondary-button" disabled={state==="loading"}>{t("searchAction")}</button></form>
  {state==="ready"?page?.items.length?<ul className="service-catalog-list">{page.items.map(row=><li key={row.id}><button type="button" className="secondary-button" onClick={()=>onSelect(row)}><span dir="auto">{row.label}</span></button></li>)}</ul>:<p>{t("noChoices")}</p>:<p role="status">{t("states."+state)}</p>}
  <div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load(query)}>{t("firstPage")}</button>{page?.next?<button type="button" className="secondary-button" onClick={()=>void load(query,page.next!)}>{t("nextPage")}</button>:null}<button type="button" className="quiet-button" onClick={onClose}>{t("close")}</button></div>
 </section>;
}
