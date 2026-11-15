import {useState} from "react";
import {useTranslations} from "next-intl";
import Decimal from "decimal.js";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {formatCurrencyAmount,formatNumber} from "@/i18n/format";
import type {serviceAllocationComponentSchema} from "@/platform/config/service-allocation-policy";
import type {ServiceCatalogItem} from "../domain/service-catalog-view";

const percentage=(locale:AppLocale,basisPoints:number)=>formatNumber(locale,new Decimal(basisPoints).div(10000),{style:"percent",maximumFractionDigits:2});
export function ServiceCatalogPercentage({locale,basisPoints}:{locale:AppLocale;basisPoints:number}){return<span dir="auto">{percentage(locale,basisPoints)}</span>;}
export function ServiceCatalogAllocationValue({locale,currency,component}:{locale:AppLocale;currency:string;component:z.infer<typeof serviceAllocationComponentSchema>}){
 const t=useTranslations("ServiceCatalog");return<span dir="auto">{component.mode==="FIXED"?formatCurrencyAmount(locale,component.amount,currency):component.mode==="BASIS_POINTS"?percentage(locale,component.basis_points):t("remainder")}</span>;
}
/** Read the actual selected versions, including retired native policy references.
 * A closed historical row renders no large hidden provider/recipe subtree. */
export function ServiceCatalogTerms({locale,item,initiallyOpen=false}:{locale:AppLocale;item:ServiceCatalogItem;initiallyOpen?:boolean}){
 const t=useTranslations("ServiceCatalog"),[open,setOpen]=useState(initiallyOpen),terms=item.orderTerms,policy=item.financialPolicy;if(!terms||!policy)return null;
 return<details className="service-catalog-original-terms" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{t("financialTerms")}</summary>{open?<div className="service-catalog-terms">
  <p>{t("currentRules",{allocation:policy.allocationRuleVersion,tax:policy.taxRuleVersion,currency:policy.recipe.currency})}</p>
  <dl className="detail-grid"><div><dt>{t("fields.cost")}</dt><dd dir="auto">{formatCurrencyAmount(locale,terms.internal_cost.amount,terms.internal_cost.currency)}</dd></div><div><dt>{t("fields.approval")}</dt><dd dir="auto">{terms.approval_reference}</dd></div></dl>
  <ul>{policy.recipe.components.map(component=><li key={component.key}>{t("beneficiaries."+component.beneficiary)} · <ServiceCatalogAllocationValue locale={locale} currency={policy.recipe.currency} component={component}/></li>)}</ul>
  <ul>{policy.taxes.map(tax=><li key={tax.key}><span dir="auto">{tax.key}</span> · <span dir="auto">{tax.service_assessment.method==="FIXED"&&tax.amount&&tax.currency?formatCurrencyAmount(locale,tax.amount,tax.currency):tax.rate_bps!==null?percentage(locale,tax.rate_bps):t("states.configuration_unavailable")}</span></li>)}</ul>
  <ul>{policy.providers.map(provider=><li key={provider.component_key}><span dir="auto">{provider.component_key}</span> · {t("beneficiaries."+provider.kind)} · <span dir="auto">{provider.label}</span></li>)}</ul>
  <p>{t("fields.availability")}</p>{"all"in terms.availability&&terms.availability.all.length===0?<p>{t("unrestricted")}</p>:<pre dir="ltr">{JSON.stringify(terms.availability,null,2)}</pre>}
 </div>:null}</details>;
}
