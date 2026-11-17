"use client";
import {useState} from "react";
import {useTranslations} from "next-intl";
import Decimal from "decimal.js";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {formatNumber} from "@/i18n/format";
import type {ServiceCatalogItem} from "../domain/service-catalog-view";
import type {ChefMenuDefinition} from "@/platform/config/chef-menu-policy";
type Recipe=Pick<ChefMenuDefinition,"serving_quantity"|"ingredients"|"preparation"|"allergens">;
export function ChefMenuRecipe({locale,menu,headingLevel=3}:{locale:AppLocale;menu:Recipe;headingLevel?:3|4}){
 const t=useTranslations("ChefMenu"),Heading=headingLevel===3?"h3":"h4";
 return<><p>{t("servings")}{" · "}<span dir="auto">{formatNumber(locale,String(menu.serving_quantity))}</span></p><p className="muted-copy">{t("servingsHelp")}</p>
  <Heading>{t("ingredients")}</Heading><ul className="service-catalog-list">{menu.ingredients.map(item=><li key={item.key}><span dir="auto">{localizedText(item.name,locale)}</span>{" · "}<span dir="auto">{formatNumber(locale,new Decimal(item.quantity),{maximumFractionDigits:6})}{" "}{localizedText(item.unit.name,locale)}</span></li>)}</ul>
  <Heading>{t("preparationTitle")}</Heading><p className="preserve-lines" dir="auto">{localizedText(menu.preparation,locale)}</p>
  <Heading>{t("allergens")}</Heading>{menu.allergens.length?<ul>{menu.allergens.map(item=><li key={item.key} dir="auto">{localizedText(item.name,locale)}</li>)}</ul>:<p>{t("noAllergens")}</p>}
 </>;
}
export function ChefMenuDetails({locale,item,initiallyOpen=false}:{locale:AppLocale;item:ServiceCatalogItem;initiallyOpen?:boolean}){
 const t=useTranslations("ChefMenu"),[open,setOpen]=useState(initiallyOpen),menu=item.orderTerms?.chef_menu;if(!menu)return null;
 const chef=item.financialPolicy?.providers.find(provider=>provider.component_key===menu.chef_component_key&&provider.kind==="PERSON");
 return<details className="service-catalog-original-terms" data-testid="chef-menu-details" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{t("details")}</summary>{open?<div className="service-catalog-terms">
  <dl className="detail-grid"><div><dt>{t("assignedChef")}</dt><dd dir="auto">{chef?.label??t("chefUnavailable")}</dd></div></dl>
  <ChefMenuRecipe locale={locale} menu={menu}/>
 </div>:null}</details>;
}
