"use client";
import {useId} from "react";
import {useTranslations} from "next-intl";
import {formatNumber} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import type {TransferRequest} from "@/platform/config/transfer-order-policy";
export function TransferDetails({locale,transfer,date,timezone,guests,headingLevel=2,showCashHelp=true}:{locale:AppLocale;transfer:TransferRequest;date:string;timezone?:string;guests:number;headingLevel?:2|3|4;showCashHelp?:boolean}){
 const t=useTranslations("Transfers"),Heading=headingLevel===2?"h2":headingLevel===3?"h3":"h4";
 return<section className="panel" data-testid="transfer-details"><Heading>{t("title")}</Heading><dl className="detail-grid"><div><dt>{t("pickup")}</dt><dd dir="auto">{transfer.pickup}</dd></div><div><dt>{t("destination")}</dt><dd dir="auto">{transfer.destination}</dd></div><div><dt>{t("pickupTime")}</dt><dd><time dateTime={date+"T"+transfer.pickupTime} dir="auto">{date} · {transfer.pickupTime}</time>{timezone?<span dir="auto"> ({timezone})</span>:null}</dd></div><div><dt>{t("guests")}</dt><dd>{formatNumber(locale,guests.toString())}</dd></div>{transfer.flightReference?<div><dt>{t("flightReference")}</dt><dd dir="auto">{transfer.flightReference}</dd></div>:null}{transfer.instructions?<div><dt>{t("instructions")}</dt><dd dir="auto">{transfer.instructions}</dd></div>:null}</dl>{showCashHelp&&<p>{t("cashHelp")}</p>}</section>;
}
export const emptyTransferForm=():TransferRequest=>({pickup:"",destination:"",pickupTime:""});
export function TransferRequestFields({value,onChange}:{value:TransferRequest;onChange:(value:TransferRequest)=>void}){
 const t=useTranslations("Transfers"),id=useId();
 return<section data-testid="transfer-request-fields"><h3>{t("title")}</h3><p>{t("timeHelp")}</p><div className="form-grid">{(["pickup","destination","pickupTime","flightReference","instructions"]as const).map(key=><div className="field" key={key}><label htmlFor={id+key}>{t(key)}</label><input id={id+key} type={key==="pickupTime"?"time":"text"} dir={key==="pickupTime"?undefined:"auto"} required={key==="pickup"||key==="destination"||key==="pickupTime"} maxLength={key==="flightReference"?100:500} value={value[key]??""} onChange={event=>{const next={...value};if((key==="instructions"||key==="flightReference")&&!event.target.value)delete next[key];else next[key]=event.target.value;onChange(next);}}/></div>)}</div></section>;
}
