"use client";
import Link from "next/link";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {formatCurrencyAmount} from "@/i18n/format";
import type {LaundryPriceChangeContext} from "../domain/laundry-price-change-view";
export function LaundryPriceChangeSource({value,locale}:{value:LaundryPriceChangeContext;locale:AppLocale}){
 const t=useTranslations("SupplierPrices");
 return <section className="detail-panel resource-form" data-testid="laundry-price-change-source"><h2>{t("priceChangeTitle")}</h2><p role="status">{t("priceChangeStates."+value.state)}</p><p>{t("priceChangeHelp")}</p>
  <p dir="auto">{value.invoice.number} · {value.receipt.title}</p><dl className="detail-grid"><div><dt>{t("retainedExpected")}</dt><dd dir="auto">{formatCurrencyAmount(locale,value.expected.amount,value.expected.currency)}</dd></div><div><dt>{t("actualInvoice")}</dt><dd dir="auto">{formatCurrencyAmount(locale,value.actual.amount,value.actual.currency)}</dd></div></dl>
  <ul className="resource-list">{value.retainedPrices.map((row,index)=><li key={row.item+":"+index}><bdi>{row.item} · {row.unit}</bdi> · {row.price?formatCurrencyAmount(locale,row.price,value.expected.currency):t("unselected")}</li>)}</ul>
  <div className="form-actions"><Link prefetch={false} href={"/"+locale+"/app/documents?document="+value.receipt.documentId+"&version="+value.receipt.version}>{t("priceEvidenceReceipt")}</Link><Link prefetch={false} href={"/"+locale+"/app/finance/supplier-invoices/"+value.invoice.id}>{t("priceEvidenceInvoice")}</Link></div>
 </section>;
}
