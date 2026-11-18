"use client";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {formatCurrencyAmount,formatPercentageAmount} from "@/i18n/format";
import {exactVariancePercentage,type VarianceFacts} from "../domain/variance-facts";

export function VarianceFactsView({facts,locale,provider,testPrefix}:{facts:VarianceFacts;locale:AppLocale;provider:string;testPrefix:"variance"|"variance-center"}){
 const t=useTranslations("VarianceCenter");
 if(facts.kind==="UNAVAILABLE")return <div className="resource-form">
  <p role="status" data-testid={testPrefix+"-comparison-unavailable"}>{t("comparison_"+facts.reason)}</p>
  <dl className="detail-grid"><div><dt>{t("expected")}</dt><dd dir="auto">{formatCurrencyAmount(locale,facts.expectedMoney.amount,facts.expectedMoney.currency)}</dd></div>
   {facts.actualMoney.map(money=><div key={money.currency}><dt>{t("actual")}</dt><dd dir="auto">{formatCurrencyAmount(locale,money.amount,money.currency)}</dd></div>)}</dl>
 </div>;
 const percentage=provider==="LAUNDRY"&&facts.kind==="MONEY"&&facts.currency?exactVariancePercentage(facts.expected,facts.actual,facts.currency):null;
 return <><dl className="detail-grid">{(["expected","actual","variance"] as const).map(key=><div key={key}><dt>{t(key)}</dt><dd data-testid={testPrefix+"-"+key} dir="auto">{facts.kind==="MONEY"&&facts.currency?formatCurrencyAmount(locale,facts[key],facts.currency):new Intl.NumberFormat(locale).format(BigInt(facts[key]))}</dd></div>)}
  {provider==="LAUNDRY"?<div><dt>{t("variancePercentage")}</dt><dd dir="auto" data-testid={testPrefix+"-percentage"}>{percentage===null?t("percentageUndefined"):formatPercentageAmount(locale,percentage)}</dd></div>:null}
 </dl>{facts.kind==="QUANTITY"?<p dir="auto">{facts.unit.startsWith("QUANTITY:")?facts.unit.slice(9):t("quantity")}</p>:null}</>;
}
