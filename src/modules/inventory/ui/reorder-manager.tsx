"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import {useCallback,useEffect,useId,useMemo,useRef,useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {SkeletonBlock} from "@/design-system/shells";
import {inventoryCategorySchema} from "@/platform/config/inventory-policy";
import {inventoryLocationKindSchema} from "../domain/location-catalog";
import {inventoryStockSelectionSchema} from "../domain/stock-levels";
import {inventoryReorderPageSchema,type InventoryReorderPage} from "../domain/reorder-view";
import {inventoryCatalogRequest,InventoryBrowserError,type InventoryBrowserState} from "./item-browser";
import type {InventoryMovementChoice} from "./movement-source-picker";
const Picker=dynamic(()=>import("./movement-source-picker").then(module=>module.InventoryMovementSourcePicker),{loading:()=> <SkeletonBlock/>});
export function InventoryReorderManager({locale,authorizationScope:scope}:{locale:AppLocale;authorizationScope:string}){
 const t=useTranslations("InventoryStockLevels"),r=useTranslations("InventoryReorder"),id=useId(),[mode,setMode]=useState<"LOCATION"|"ITEM">("LOCATION"),[choice,setChoice]=useState<InventoryMovementChoice|null>(null),[picker,setPicker]=useState(false),[query,setQuery]=useState(""),[category,setCategory]=useState(""),[kind,setKind]=useState(""),[includeRetired,setIncludeRetired]=useState(false),[page,setPage]=useState<InventoryReorderPage|null>(null),[state,setState]=useState<InventoryBrowserState>("ready"),[visible,setVisible]=useState(true),controller=useRef<AbortController|null>(null),epoch=useRef(0);
 const invalidate=useCallback(()=>{controller.current?.abort();epoch.current++;},[]);
 const denied=useCallback(()=>{invalidate();setPage(null);setChoice(null);setQuery("");setPicker(false);setState("forbidden");},[invalidate]);
 const load=useCallback(async(selected:InventoryMovementChoice|null=choice,after?:string,search=query)=>{
  invalidate();if(!selected){setPage(null);setState("ready");return;}const own=epoch.current,abort=new AbortController();controller.current=abort;setPicker(false);setPage(null);setState("loading");
  try{
   const input=inventoryStockSelectionSchema.parse({mode,query:search,includeRetired,...mode==="LOCATION"?{locationId:selected.id,...category?{category}:{}}:{itemId:selected.id,...kind?{kind}:{}},...after?{after}:{}}),value=inventoryReorderPageSchema.parse(await inventoryCatalogRequest("reorder","page",input,abort.signal,scope));
   if(JSON.stringify(value.selection)!==JSON.stringify(input)||value.source.mode!==mode||(value.source.mode==="LOCATION"?value.source.location.id:value.source.item.id)!==selected.id)throw new InventoryBrowserError("forbidden");if(abort.signal.aborted||own!==epoch.current)return;setPage(value);setState("ready");
  }catch(error){if(abort.signal.aborted||own!==epoch.current)return;setPage(null);if(error instanceof InventoryBrowserError&&error.state==="forbidden")denied();else setState(error instanceof InventoryBrowserError?error.state:"unavailable");}
 },[invalidate,choice,query,mode,includeRetired,category,kind,scope,denied]);
 useEffect(()=>{
  const hide=()=>{invalidate();setVisible(false);setPage(null);setChoice(null);setQuery("");setPicker(false);},show=()=>{if(document.hidden)return;setVisible(true);setPage(null);setChoice(null);setState(navigator.onLine?"ready":"offline");},visibility=()=>document.hidden?hide():show(),offline=()=>{hide();setState("offline");},pageShow=(event:PageTransitionEvent)=>{if(event.persisted)show();};
  let mounted=true;document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",pageShow);window.addEventListener("offline",offline);window.addEventListener("online",show);queueMicrotask(()=>{if(mounted){if(document.hidden)hide();else show();}});
  return()=>{mounted=false;invalidate();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",pageShow);window.removeEventListener("offline",offline);window.removeEventListener("online",show);};
 },[invalidate,scope]);
 function search(event:FormEvent){event.preventDefault();void load();}
 function clearResult(){invalidate();setPage(null);setState("ready");}
 const formatter=useMemo(()=>new Intl.NumberFormat(locale),[locale]),dateFormatter=useMemo(()=>new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short"}),[locale]);
 const number=(value:string)=>formatter.format(BigInt(value));
 if(!visible)return <div className="resource-form" data-testid="inventory-reorder-manager"><p role="status">{t(state==="offline"?"states.offline":"privateHidden")}</p></div>;
 return <div className="resource-form" data-testid="inventory-reorder-manager"><p>{r("help")}</p><div className="form-actions"><Link className="secondary-button" prefetch={false} href={"/"+locale+"/app/configuration?ruleKey=inventory.minimums"}>{r("minimumRules")}</Link><Link className="secondary-button" prefetch={false} href={"/"+locale+"/app/automations"}>{r("automationRules")}</Link></div><div className="filter-bar"><div className="field"><label htmlFor={id+"mode"}>{t("view")}</label><select id={id+"mode"} value={mode} onChange={event=>{clearResult();setChoice(null);setPicker(false);setMode(event.target.value as typeof mode);setQuery("");setKind("");setCategory("");}}><option value="LOCATION">{t("modes.LOCATION")}</option><option value="ITEM">{t("modes.ITEM")}</option></select></div><button type="button" className="secondary-button" disabled={state==="forbidden"||state==="offline"} onClick={()=>setPicker(true)}>{t(mode==="LOCATION"?"chooseLocation":"chooseItem")}</button>{choice?<p dir="auto">{choice.label}</p>:null}<button type="button" className="quiet-button" disabled={!choice||state==="loading"} onClick={()=>void load()}>{t("refresh")}</button></div>
  {picker?<Picker key={mode} scope={scope} locale={locale} kind={mode==="LOCATION"?"locations":"items"} activeReservation={false} allowRetired onDenied={denied} onClose={()=>setPicker(false)} onSelect={value=>{setChoice(value);setQuery("");void load(value,undefined,"");}}/>:null}
  {choice?<form className="filter-bar" onSubmit={search}><div className="field"><label htmlFor={id+"query"}>{t("search")}</label><input id={id+"query"} type="search" maxLength={100} value={query} onChange={event=>{clearResult();setQuery(event.target.value);}}/></div><div className="field"><label htmlFor={id+"filter"}>{t(mode==="LOCATION"?"category":"kind")}</label><select id={id+"filter"} value={mode==="LOCATION"?category:kind} onChange={event=>{clearResult();if(mode==="LOCATION")setCategory(event.target.value);else setKind(event.target.value);}}><option value="">{t("all")}</option>{(mode==="LOCATION"?inventoryCategorySchema.options:inventoryLocationKindSchema.options).map(value=><option key={value} value={value}>{t((mode==="LOCATION"?"categories.":"kinds.")+value)}</option>)}</select></div><label className="checkbox-field"><input type="checkbox" checked={includeRetired} onChange={event=>{clearResult();setIncludeRetired(event.target.checked);}}/>{t("includeRetired")}</label><button type="submit" className="secondary-button" disabled={state==="loading"}>{t("apply")}</button></form>:null}
  {state==="loading"?<SkeletonBlock/>:state!=="ready"?<p role="alert">{t("states."+state)}</p>:page?<>
   <section className="detail-panel"><h2 dir="auto">{page.source.mode==="LOCATION"?page.source.location.label:localizedText(page.source.item.name,locale)}</h2>{page.source.mode==="ITEM"?<p dir="auto">{page.source.item.key} · {page.source.item.unit??t("unspecifiedUnit")}</p>:page.source.location.propertyName?<p dir="auto">{page.source.location.propertyName}</p>:null}{(page.source.mode==="LOCATION"?page.source.location.retired:page.source.item.retired)?<p>{t("retired")}</p>:null}<p>{t("observedAt")} · <time dateTime={page.observedAt}>{dateFormatter.format(new Date(page.observedAt))}</time></p><p>{t(page.selection.mode==="LOCATION"?"separateUnits":"totalsHelp")}</p>
    {page.totals?<dl className="inventory-stock-totals" data-testid="inventory-stock-totals">{(["quantity","reserved","damaged","available","shortage","conditionShortage","locationCount"]as const).map(field=><div key={field}><dt>{t("dimensions."+field)}</dt><dd dir="ltr">{number(page.totals![field])}</dd></div>)}</dl>:null}
   </section>
   {page.items.length?<ul className="service-catalog-list">{page.items.map(row=><li className="detail-panel" key={row.location.id+":"+row.item.id} data-testid="inventory-reorder-row" data-item-id={row.item.id} data-location-id={row.location.id}>
    <h3 dir="auto">{localizedText(row.item.name,locale)}</h3><p dir="auto">{row.item.key} · {row.location.label} · {row.item.unit??t("unspecifiedUnit")}</p>
    {row.minimum?<><p>{r("basis."+row.minimum.basis)} · {r(row.minimum.belowMinimum?"belowMinimum":"sufficient")}</p><dl className="inventory-stock-totals">{(["current","minimum","target","suggestedQuantity"]as const).map(key=><div key={key}><dt>{r(key)}</dt><dd dir="ltr" data-reorder-field={key}>{number(row.minimum![key])}</dd></div>)}</dl>
     {row.latestSuggestion?<section data-testid="inventory-reorder-recorded"><h4>{r("latestRecorded")}</h4><p dir="auto">{localizedText(row.latestSuggestion.title,locale)}</p><p><span dir="ltr">{number(row.latestSuggestion.quantity)}</span> · <time dateTime={row.latestSuggestion.createdAt}>{dateFormatter.format(new Date(row.latestSuggestion.createdAt))}</time></p></section>:row.minimum.belowMinimum?<p>{r("awaitingAutomation")}</p>:null}</>:<p>{r("noMinimum")}</p>}
   </li>)}</ul>:<p>{t("empty")}</p>}
   <div className="form-actions"><button type="button" className="quiet-button" onClick={()=>void load()}>{t("firstPage")}</button>{page.next?<button type="button" className="secondary-button" onClick={()=>void load(choice,page.next!)}>{t("nextPage")}</button>:null}<Link className={page.canRecord?"primary-button":"secondary-button"} prefetch={false} href={"/"+locale+"/app/inventory/movements"}>{t(page.canRecord?"recordMovement":"history")}</Link></div>
  </>:<p>{t(choice?"applyHelp":"chooseHelp")}</p>}
 </div>;
}
