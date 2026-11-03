"use client";
import Link from "next/link";
import {useState} from "react";
import {useTranslations} from "next-intl";
import {SkeletonBlock} from "@/design-system/shells";
import {formatCurrencyAmount,formatDateTime} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import {serviceAllocationProviderHistorySchema} from "../domain/service-allocation-workspace";
import {useCompensationRead} from "./use-compensation-read";

export function ServiceAllocationProviderHistory({sourceId,bindingId,locale,onInvalidate,revision}:{sourceId:string;bindingId:string;locale:AppLocale;onInvalidate:()=>void;revision:number}){
 const t=useTranslations("ServiceAllocations"),[before,setBefore]=useState<string|undefined>(),read=useCompensationRead("/api/finance/service-allocations/read",serviceAllocationProviderHistorySchema,onInvalidate,JSON.stringify({operation:"PROVIDER_HISTORY",sourceId,bindingId,before}),revision);
 if(read.error)return <p role="alert">{t(read.error)}</p>;if(read.pending||!read.data)return <SkeletonBlock rows={3}/>;const data=read.data,reference=data.reference,href=reference.kind==="INVOICE"?`/${locale}/app/finance/supplier-invoices/${reference.id}`:`/${locale}/app/finance/compensation/proposals/${reference.id}/claims/${reference.claimId}/payments`;
 return <section className="resource-form" data-testid="service-provider-payments"><h4 dir="auto">{data.label}</h4><p>{t("originalCost",{amount:formatCurrencyAmount(locale,data.cost.amount,data.cost.currency)})}</p><p>{t(`scope_${data.scope}`)}</p><p>{t("outstanding",{amount:formatCurrencyAmount(locale,data.outstanding.amount,data.outstanding.currency)})}</p>{data.sourceReversed?<p>{t("sourceReversed")}</p>:null}<Link className="secondary-button" href={href} prefetch={false}>{t("openOriginal")}</Link><ol>{data.payments.map(payment=><li key={payment.id}><p>{formatCurrencyAmount(locale,payment.amount.amount,payment.amount.currency)} · {formatDateTime(locale,new Date(payment.paidAt),{timeZone:"UTC"})}</p><p dir="auto">{payment.fundingName} · {payment.reference}</p><p dir="auto">{payment.reason}</p>{payment.reversed?<p>{t("paymentReversed")}</p>:null}</li>)}</ol>{!data.payments.length?<p>{t("noPayments")}</p>:null}<div className="form-actions">{before?<button className="secondary-button" type="button" onClick={()=>setBefore(undefined)}>{t("first")}</button>:null}{data.next?<button className="secondary-button" type="button" onClick={()=>setBefore(data.next!)}>{t("next")}</button>:null}</div></section>;
}
