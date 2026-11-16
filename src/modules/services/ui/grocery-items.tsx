"use client";
import {useId} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {groceryItemsSchema} from "@/platform/config/grocery-order-policy";
import type {AppLocale} from "@/i18n/routing";
import {formatRecipeQuantity} from "@/i18n/format";
export type GroceryItemForm={rowId:string;name:string;quantity:string;unit:string;notes:string};
export function GroceryItemsEditor({value,onChange}:{value:readonly GroceryItemForm[];onChange:(value:GroceryItemForm[])=>void}){
 const t=useTranslations("Groceries"),id=useId();
 function change(index:number,key:"name"|"quantity"|"unit"|"notes",next:string){onChange(value.map((item,i)=>i===index?{...item,[key]:next}:item));}
 return<section data-testid="grocery-items-editor"><h3>{t("items")}</h3>{value.map((item,index)=><fieldset key={item.rowId}><legend>{t("itemNumber",{number:index+1})}</legend><div className="form-grid">{(["name","quantity","unit","notes"]as const).map(key=><div className="field" key={key}><label htmlFor={id+item.rowId+key}>{t(key)}</label><input id={id+item.rowId+key} dir="auto" inputMode={key==="quantity"?"decimal":undefined} required={key!=="notes"} maxLength={key==="quantity"?19:key==="unit"?80:key==="name"?240:500} value={item[key]} onChange={event=>change(index,key,event.target.value)}/></div>)}</div><button type="button" className="quiet-button" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>{t("remove")}</button></fieldset>)}<button type="button" className="secondary-button" disabled={value.length>=100} onClick={()=>onChange([...value,{rowId:crypto.randomUUID(),name:"",quantity:"",unit:"",notes:""}])}>{t("add")}</button></section>;
}
export function GroceryItems({locale,items}:{locale:AppLocale;items:z.infer<typeof groceryItemsSchema>}){const t=useTranslations("Groceries");return<section data-testid="grocery-items"><h3>{t("items")}</h3><ul className="service-catalog-list">{items.map((item,index)=><li key={index}><span dir="auto">{item.name}</span>{" · "}<strong dir="auto">{formatRecipeQuantity(locale,item.quantity)}{" "}{item.unit}</strong>{item.notes?<p dir="auto">{item.notes}</p>:null}</li>)}</ul></section>;}
