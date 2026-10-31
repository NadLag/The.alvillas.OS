"use client";
import {useId,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {formatCurrencyAmount,formatDateTime,formatNumber} from "@/i18n/format";
import type {employeeCompensationRunDetailSchema} from "../domain/employee-compensation-workspace";

type Coverage=NonNullable<z.infer<typeof employeeCompensationRunDetailSchema>["labels"][number]["percentageCoverage"]>;
export function CompensationPercentageEvidenceGroups({locale,groups}:{locale:AppLocale;groups:readonly {runLineId:string;coverage:Coverage}[]}){
 const t=useTranslations("CompensationRuns"),[index,setIndex]=useState(0),selected=Math.min(index,groups.length-1),group=groups[selected];
 if(!group)return null;
 return <section className="compensation-history" aria-label={t("percentageEvidence")}>
  {groups.length>1?<div className="app-actions"><button type="button" className="secondary-button" disabled={selected===0} onClick={()=>setIndex(selected-1)}>{t("percentagePreviousGroup")}</button><span role="status">{t("percentageGroupPage",{current:formatNumber(locale,String(selected+1)),total:formatNumber(locale,String(groups.length))})}</span><button type="button" className="secondary-button" disabled={selected===groups.length-1} onClick={()=>setIndex(selected+1)}>{t("percentageNextGroup")}</button></div>:null}
  <CompensationPercentageEvidence key={group.runLineId} locale={locale} coverage={group.coverage} headingLevel={3}/>
 </section>;
}
export function CompensationPercentageEvidence({locale,coverage,headingLevel=4}:{locale:AppLocale;coverage:Coverage;headingLevel?:3|4}){
 const t=useTranslations("CompensationRuns"),headingId=useId(),Heading=headingLevel===3?"h3":"h4",[page,setPage]=useState(0),size=25,offset=page*size,sources=coverage.sources.slice(offset,offset+size);
 return <div role="group" data-testid="compensation-percentage-evidence" aria-labelledby={headingId}>
  <Heading id={headingId}>{t("percentageEvidence")}</Heading>
  <dl className="compensation-evidence"><div><dt>{t("percentageBaseAmount")}</dt><dd data-testid="compensation-percentage-base-total">{formatCurrencyAmount(locale,coverage.baseAmount.amount,coverage.baseAmount.currency)}</dd></div><div><dt>{t("percentageEarnedAmount")}</dt><dd data-testid="compensation-percentage-earned-total">{formatCurrencyAmount(locale,coverage.amount.amount,coverage.amount.currency)}</dd></div></dl>
  <p>{t("percentageBaseCount",{count:coverage.baseCount})} · {t("percentageJournalCount",{count:coverage.journalCount})}</p><p>{t("percentageUTC")}</p>
  <ol start={offset+1}>{sources.map(source=><li key={source.postingId}><p dir="auto" style={{overflowWrap:"anywhere"}}>{source.reference}</p><p><time dateTime={source.occurredAt}>{formatDateTime(locale,new Date(source.occurredAt),{timeZone:"UTC"})}</time></p><p>{formatCurrencyAmount(locale,source.amount.amount,source.amount.currency)} · {t("percentageRate",{amount:formatNumber(locale,source.rate.amount,{minimumFractionDigits:2,maximumFractionDigits:2})})}</p><p>{t("hourlyContractVersion",{version:source.contractVersion})}</p></li>)}</ol>
  {coverage.sources.length>size?<div role="group" aria-label={t("percentageNavigation")}><button className="secondary-button" type="button" disabled={page===0} onClick={()=>setPage(current=>current-1)}>{t("percentagePrevious")}</button><span role="status">{t("percentagePage",{from:offset+1,to:Math.min(offset+size,coverage.sources.length),total:coverage.sources.length})}</span><button className="secondary-button" type="button" disabled={offset+size>=coverage.sources.length} onClick={()=>setPage(current=>current+1)}>{t("percentageNext")}</button></div>:null}
  <p>{t("percentageRounding")}</p>
 </div>;
}
