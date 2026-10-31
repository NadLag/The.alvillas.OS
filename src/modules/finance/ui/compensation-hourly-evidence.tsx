"use client";
import { useId,useState } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrencyAmount,formatDateTime } from "@/i18n/format";
import type { employeeCompensationRunDetailSchema } from "../domain/employee-compensation-workspace";
type Coverage=NonNullable<z.infer<typeof employeeCompensationRunDetailSchema>["labels"][number]["hourlyCoverage"]>;
export function CompensationHourlyEvidence({locale,coverage,headingLevel=4}:{locale:AppLocale;coverage:Coverage;headingLevel?:3|4}){
 const t=useTranslations("CompensationRuns"),headingId=useId(),Heading=headingLevel===3?"h3":"h4",[page,setPage]=useState(0),size=25,offset=page*size,rates=coverage.rates.slice(offset,offset+size),integer=(value:string)=>new Intl.NumberFormat(locale).format(BigInt(value));
 const duration=(value:Coverage["duration"])=>t("hourlyDuration",{hours:integer(value.hours),minutes:integer(value.minutes),seconds:new Intl.NumberFormat(locale,{maximumFractionDigits:3}).format(Number(value.seconds))});
 const instant=(value:string)=>formatDateTime(locale,new Date(value),{dateStyle:undefined,timeStyle:undefined,timeZone:"UTC",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",fractionalSecondDigits:3});
 return <div role="group" data-testid="compensation-hourly-evidence" aria-labelledby={headingId}>
  <Heading id={headingId}>{t("hourlyEvidence")}</Heading><dl className="compensation-evidence"><div><dt>{t("hourlyActualDuration")}</dt><dd data-testid="compensation-hourly-duration">{duration(coverage.duration)}</dd></div><div><dt>{t("hourlyValidation")}</dt><dd>{t("hourlyEvidenceVersion",{version:coverage.evidenceVersion})}<small>{instant(coverage.validatedAt)}</small></dd></div></dl>
  <p>{t("hourlyUTC")}</p><h4>{t("hourlyAppliedRates")}</h4><ol start={offset+1}>{rates.map(rate=><li key={rate.startsAt+":"+rate.endsAt}><p>{t("perHour",{amount:formatCurrencyAmount(locale,rate.rate.amount,rate.rate.currency)})}</p><p><time dateTime={rate.startsAt}>{instant(rate.startsAt)}</time> {t("through")} <time dateTime={rate.endsAt}>{instant(rate.endsAt)}</time></p><p>{duration(rate.duration)} · {t("hourlyContractVersion",{version:rate.contractVersion})}</p></li>)}</ol>
  {coverage.rates.length>size?<div role="group" aria-label={t("hourlyRatesNavigation")}><button type="button" className="secondary-button" disabled={page===0} onClick={()=>setPage(current=>current-1)}>{t("hourlyPreviousRates")}</button><span role="status">{t("hourlyRatePage",{from:offset+1,to:Math.min(offset+size,coverage.rates.length),total:coverage.rates.length})}</span><button type="button" className="secondary-button" disabled={offset+size>=coverage.rates.length} onClick={()=>setPage(current=>current+1)}>{t("hourlyNextRates")}</button></div>:null}
  <p>{t("hourlyRounding")}</p>
 </div>;
}
