"use client";
import {useId} from "react";
import {useTranslations} from "next-intl";
import {chefMenuSchema,type ChefMenuDefinition} from "@/platform/config/chef-menu-policy";

type Text={en:string;fr:string;ar:string};
type Ingredient={rowId:string;key:string;name:Text;quantity:string;unit:{key:string;name:Text}};
type Allergen={rowId:string;key:string;name:Text};
export type ChefMenuForm={enabled:boolean;servings:string;chefComponent:string;preparation:Text;ingredients:Ingredient[];allergens:Allergen[]};
const emptyText=():Text=>({en:"",fr:"",ar:""});
export function initialChefMenuForm(menu:ChefMenuDefinition|undefined):ChefMenuForm{
 return{enabled:Boolean(menu),servings:menu?String(menu.serving_quantity):"",chefComponent:menu?.chef_component_key??"",preparation:menu?.preparation??emptyText(),ingredients:menu?.ingredients.map((item,index)=>({...item,rowId:"ingredient-"+index}))??[],allergens:menu?.allergens.map((item,index)=>({...item,rowId:"allergen-"+index}))??[]};
}
export function chefMenuFromForm(form:ChefMenuForm){
 if(!form.enabled)return undefined;
 return chefMenuSchema.parse({schemaVersion:1,serving_quantity:Number(form.servings),serving_basis:"PER_PRICED_UNIT",chef_component_key:form.chefComponent,preparation:form.preparation,ingredients:form.ingredients.map(item=>({key:item.key,name:item.name,quantity:item.quantity,unit:item.unit})),allergens:form.allergens.map(item=>({key:item.key,name:item.name}))});
}
type Props={value:ChefMenuForm;onChange:(value:ChefMenuForm)=>void;personComponents:readonly {key:string;label:string}[]};
export function ChefMenuFields({value,onChange,personComponents}:Props){
 const t=useTranslations("ChefMenu"),id=useId();
 function textFields(prefix:string,label:"ingredientName"|"unitName"|"allergenName",text:Text,change:(next:Text)=>void){
  return(["en","fr","ar"]as const).map(locale=><div className="field" key={locale}><label htmlFor={id+prefix+locale}>{t(label+"."+locale)}</label><input id={id+prefix+locale} dir="auto" lang={locale} required maxLength={240} value={text[locale]} onChange={event=>change({...text,[locale]:event.target.value})}/></div>);
 }
 const changeIngredient=(index:number,item:Ingredient)=>onChange({...value,ingredients:value.ingredients.map((previous,i)=>i===index?item:previous)});
 const changeAllergen=(index:number,item:Allergen)=>onChange({...value,allergens:value.allergens.map((previous,i)=>i===index?item:previous)});
 return<section className="service-catalog-terms" data-testid="chef-menu-fields">
  <label className="checkbox-field"><input type="checkbox" checked={value.enabled} onChange={event=>onChange({...value,enabled:event.target.checked})}/>{t("configure")}</label>
  {value.enabled?<><h3>{t("title")}</h3><p className="muted-copy">{t("canonicalHelp")}</p><div className="form-grid">
   <div className="field"><label htmlFor={id+"servings"}>{t("servings")}</label><input id={id+"servings"} type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required value={value.servings} onChange={event=>onChange({...value,servings:event.target.value})}/><p className="muted-copy">{t("servingsHelp")}</p></div>
   <div className="field"><label htmlFor={id+"chef"}>{t("assignedChef")}</label><select id={id+"chef"} required value={value.chefComponent} onChange={event=>onChange({...value,chefComponent:event.target.value})}><option value="">{t("chooseChef")}</option>{personComponents.map(part=><option key={part.key} value={part.key}>{part.key}{part.label?" · "+part.label:""}</option>)}</select><p className="muted-copy">{t("chefHelp")}</p></div>
  </div><h4>{t("ingredients")}</h4>
  {value.ingredients.map((item,index)=><fieldset key={item.rowId}><legend>{t("ingredientNumber",{number:index+1})}</legend><div className="form-grid">
   <div className="field"><label htmlFor={id+item.rowId+"key"}>{t("ingredientKey")}</label><input id={id+item.rowId+"key"} dir="ltr" required maxLength={120} value={item.key} onChange={event=>changeIngredient(index,{...item,key:event.target.value})}/></div>
   {textFields(item.rowId+"name","ingredientName",item.name,name=>changeIngredient(index,{...item,name}))}
   <div className="field"><label htmlFor={id+item.rowId+"quantity"}>{t("ingredientQuantity")}</label><input id={id+item.rowId+"quantity"} inputMode="decimal" dir="ltr" required maxLength={19} value={item.quantity} onChange={event=>changeIngredient(index,{...item,quantity:event.target.value})}/></div>
   <div className="field"><label htmlFor={id+item.rowId+"unit"}>{t("unitKey")}</label><input id={id+item.rowId+"unit"} dir="ltr" required maxLength={120} value={item.unit.key} onChange={event=>changeIngredient(index,{...item,unit:{...item.unit,key:event.target.value}})}/></div>
   {textFields(item.rowId+"unit","unitName",item.unit.name,name=>changeIngredient(index,{...item,unit:{...item.unit,name}}))}
  </div><button type="button" className="quiet-button" onClick={()=>onChange({...value,ingredients:value.ingredients.filter((_,i)=>i!==index)})}>{t("removeIngredient")}</button></fieldset>)}
  <button type="button" className="secondary-button" disabled={value.ingredients.length>=100} onClick={()=>onChange({...value,ingredients:[...value.ingredients,{rowId:crypto.randomUUID(),key:"",name:emptyText(),quantity:"",unit:{key:"",name:emptyText()}}]})}>{t("addIngredient")}</button>
  <h4>{t("preparationTitle")}</h4><div className="form-grid">{(["en","fr","ar"]as const).map(locale=><div className="field" key={locale}><label htmlFor={id+"preparation"+locale}>{t("preparation."+locale)}</label><textarea id={id+"preparation"+locale} lang={locale} dir="auto" rows={4} required maxLength={4000} value={value.preparation[locale]} onChange={event=>onChange({...value,preparation:{...value.preparation,[locale]:event.target.value}})}/></div>)}</div>
  <h4>{t("allergens")}</h4><p className="muted-copy">{t("allergenHelp")}</p>
  {value.allergens.map((item,index)=><fieldset key={item.rowId}><legend>{t("allergenNumber",{number:index+1})}</legend><div className="form-grid"><div className="field"><label htmlFor={id+item.rowId+"key"}>{t("allergenKey")}</label><input id={id+item.rowId+"key"} dir="ltr" required maxLength={120} value={item.key} onChange={event=>changeAllergen(index,{...item,key:event.target.value})}/></div>{textFields(item.rowId+"name","allergenName",item.name,name=>changeAllergen(index,{...item,name}))}</div><button type="button" className="quiet-button" onClick={()=>onChange({...value,allergens:value.allergens.filter((_,i)=>i!==index)})}>{t("removeAllergen")}</button></fieldset>)}
  <button type="button" className="secondary-button" disabled={value.allergens.length>=50} onClick={()=>onChange({...value,allergens:[...value.allergens,{rowId:crypto.randomUUID(),key:"",name:emptyText()}]})}>{t("addAllergen")}</button>
  </>:null}
 </section>;
}
