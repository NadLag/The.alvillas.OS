"use client";
import { CompensationMonthlyEvidence } from "./compensation-monthly-evidence";
import { CompensationHourlyEvidence } from "./compensation-hourly-evidence";
import {CompensationPercentageEvidence} from "./compensation-percentage-evidence";
import Link from "next/link";
import { useRef,useState,type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { SkeletonBlock,StatusBadge } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate,formatDateTime,formatNumber } from "@/i18n/format";
import { localizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationRunCancelSchema } from "../domain/employee-compensation-run";
import { employeeCompensationRunDetailSchema } from "../domain/employee-compensation-workspace";
import { useCompensationRead } from "./use-compensation-read";
import { CompensationCostNavigation } from "./compensation-cost-list";

export function CompensationRunDetail({locale,runId,after}:{locale:AppLocale;runId:string;after?:string}){
  const t=useTranslations("CompensationRuns"),query=after?`?${new URLSearchParams({after})}`:"";
  const resource=useCompensationRead(`/api/finance/compensation/runs/${runId}/detail${query}`,employeeCompensationRunDetailSchema),run=resource.data;
  const labels=new Map(run?.labels.map(row=>[row.lineId,row])??[]);
  return <div aria-busy={resource.pending} data-testid="compensation-detail">
    {resource.pending?<><p role="status">{t("loading")}</p><SkeletonBlock rows={5}/></>:null}
    {resource.error?<div role="alert" className="compensation-notice" data-testid="compensation-error"><p>{t(resource.error)}</p><button className="secondary-button" type="button" onClick={()=>{void resource.refresh();}}>{t("retryRead")}</button></div>:null}
    {run?<>
      <section className="compensation-summary" aria-labelledby="compensation-purpose"><div><StatusBadge tone={run.state==="DRAFT"?"warning":"neutral"}>{t(`states.${run.state}`)}</StatusBadge><h2 id="compensation-purpose" dir="auto" data-testid="compensation-purpose">{run.purpose}</h2><p>{t("draftGuidance")}</p></div>
        <dl><div><dt>{t("expected")}</dt><dd className="compensation-total" data-testid="compensation-total">{formatCurrencyAmount(locale,run.total.amount,run.total.currency)}</dd></div><div><dt>{t(["MONTHLY_CONTRACT_DRAFT","PERCENTAGE_POSTED_DRAFT"].includes(run.kind)?"monthlyContractCount":"workCount")}</dt><dd>{new Intl.NumberFormat(locale).format(run.lineCount)}</dd></div><div><dt>{t("period")}</dt><dd>{formatDate(locale,new Date(run.fromOn+"T12:00:00Z"),{timeZone:"UTC"})} {t("through")} {formatDate(locale,new Date(run.toOn+"T12:00:00Z"),{timeZone:"UTC"})}<small>{t(run.kind==="MONTHLY_CONTRACT_DRAFT"?"monthlyTimezone":run.kind==="PERCENTAGE_POSTED_DRAFT"?"percentageTimezone":"recordedTimezone",{timezone:run.timezone})}</small></dd></div></dl>
      </section>
      <CompensationCostNavigation locale={locale} runId={runId}/>
      <section aria-labelledby="compensation-sources"><h2 id="compensation-sources">{t(run.kind==="MONTHLY_CONTRACT_DRAFT"?"monthlySources":run.kind==="PERCENTAGE_POSTED_DRAFT"?"percentageSources":"sources")}</h2><p>{t(run.kind==="MONTHLY_CONTRACT_DRAFT"?"monthlySourceGuidance":run.kind==="PERCENTAGE_POSTED_DRAFT"?"percentageSourceGuidance":"sourceGuidance")}</p><ol className="compensation-source-list" start={after?undefined:1}>{run.lines.map(line=>{
        const label=labels.get(line.id);if(!label)return null;
        const variedRates=label.percentageCoverage&&new Set(label.percentageCoverage.sources.map(source=>source.rate.amount)).size>1;
        return <li className="compensation-source" key={line.id} data-testid="compensation-source"><div className="compensation-source-heading"><div><h3>{label.sourceTitle?localizedText(label.sourceTitle,locale):t(label.earningKind==="PER_MONTH"?"monthlyWork":label.earningKind==="PERCENTAGE"?"percentageWork":"completedWork")}</h3><p dir="auto" data-testid="compensation-property">{line.propertyId===null?t("companyCost"):label.propertyName??t("restrictedProperty")}</p></div><strong className="compensation-numeric">{formatCurrencyAmount(locale,line.amount.amount,line.amount.currency)}</strong></div>
          <dl className="compensation-evidence"><div><dt>{t(["PER_MONTH","PERCENTAGE"].includes(label.earningKind??"")?"beneficiary":"performer")}</dt><dd dir="auto" data-testid="compensation-performer">{label.personName??t("restrictedPerson")}</dd></div><div><dt>{t("contract")}</dt><dd dir="auto">{label.roleName}<small>{t("contractVersion",{version:label.contractVersion,at:formatDate(locale,new Date(label.effectiveFrom),{timeZone:"UTC"})})}</small></dd></div><div><dt>{t("rate")}</dt><dd>{label.earningKind==="PERCENTAGE"?variedRates?t("percentageVariedRates"):t("percentageRate",{amount:formatNumber(locale,line.rate.amount,{minimumFractionDigits:2,maximumFractionDigits:2})}):t(label.earningKind==="PER_MONTH"?"monthlyRate":label.earningKind==="PER_HOUR"?"perHour":"perJob",{amount:formatCurrencyAmount(locale,line.rate.amount,line.rate.currency)})}</dd></div><div><dt>{t(label.earningKind==="PER_MONTH"?"earnedThrough":label.earningKind==="PERCENTAGE"?"percentagePostedAt":"completion")}</dt><dd>{label.earningKind==="PER_MONTH"?t("monthlyWork"):label.earningKind==="PERCENTAGE"?t("percentageWork"):t(`methods.${label.completionMethod}`)}<small>{formatDateTime(locale,new Date(line.recordedCompletionAt),{timeZone:run.timezone})}</small></dd></div>
            {label.completionMethod==="PROXY"?<div><dt>{t("validator")}</dt><dd dir="auto" data-testid="compensation-validator">{label.validatorName??t("restrictedPerson")}{label.validatedAt?<small>{formatDateTime(locale,new Date(label.validatedAt),{timeZone:run.timezone})}</small>:null}</dd></div>:null}</dl>{label.monthlyCoverage?<CompensationMonthlyEvidence locale={locale} coverage={label.monthlyCoverage}/>:null}{label.hourlyCoverage?<CompensationHourlyEvidence locale={locale} coverage={label.hourlyCoverage}/>:null}{label.percentageCoverage?<CompensationPercentageEvidence locale={locale} coverage={label.percentageCoverage}/>:null}
        </li>;
      })}</ol>
      {after?<Link className="secondary-button" href={`/${locale}/app/finance/compensation/${runId}`} prefetch={false}>{t("firstSources")}</Link>:null}
      {run.nextCursor?<Link className="secondary-button" href={`/${locale}/app/finance/compensation/${runId}?${new URLSearchParams({after:run.nextCursor})}`} prefetch={false} data-testid="compensation-next-sources">{t("nextSources")}</Link>:null}</section>
      <section className="compensation-history" aria-labelledby="compensation-history"><h2 id="compensation-history">{t("history")}</h2><ol>{run.history.map(event=><li key={event.action}><strong>{t(`historyActions.${event.action}`)}</strong><time dateTime={event.at}>{formatDateTime(locale,new Date(event.at),{timeZone:run.timezone})}</time><p dir="auto">{event.reason}</p></li>)}</ol></section>
    </>:null}
    <CompensationRunCancellation runId={runId} allowed={run?.canCancel??false} refresh={resource.refresh} deny={()=>resource.clear("forbidden")}/>
  </div>;
}

function CompensationRunCancellation({runId,allowed,refresh,deny}:{runId:string;allowed:boolean;refresh:()=>Promise<void>;deny:()=>void}){
  const t=useTranslations("CompensationRuns"),[pending,setPending]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<string|null>(null),[reason,setReason]=useState("");
  const intent=useRef<{id:string;reason:string}|null>(null),inFlight=useRef(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(inFlight.current)return;
    const parsed=employeeCompensationRunCancelSchema.safeParse(intent.current??{id:runId,reason});
    if(!parsed.success){setError("validation");return;}
    if(!navigator.onLine){setError("offline");return;}
    intent.current=parsed.data;inFlight.current=true;setPending(true);setError(null);
    try{
      const response=await fetch(`/api/finance/compensation/runs/${runId}/cancel`,{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({reason:intent.current.reason})});
      if(response.status===401||response.status===403){intent.current=null;setReason("");setUncertain(false);deny();return;}
      if(!response.ok){setUncertain(true);setError(response.status===409?"conflict":"uncertain");return;}
      // A success body must identify this exact run before the command is considered acknowledged.
      const receipt:unknown=await response.json();if(!receipt||typeof receipt!=="object"||!("id" in receipt)||receipt.id!==runId)throw Error("Invalid cancellation acknowledgement");
      intent.current=null;setUncertain(false);await refresh();
    }catch{setUncertain(true);setError("uncertain");}
    finally{inFlight.current=false;setPending(false);}
  }
  if(!allowed)return null;
  return <form className="resource-form compensation-cancellation" data-testid="compensation-cancel-form" aria-busy={pending} onSubmit={event=>{void submit(event);}}>
    <h2>{t("cancelTitle")}</h2><p>{t("cancelGuidance")}</p>
    {error?<p role="alert" data-testid="compensation-command-error">{t(error)}</p>:null}
    <fieldset disabled={pending}><legend className="sr-only">{t("cancelTitle")}</legend><label className="field"><span>{t("cancelReason")}</span><textarea name="reason" data-testid="compensation-cancel-reason" minLength={6} maxLength={500} required readOnly={uncertain} dir="auto" value={reason} onChange={event=>setReason(event.target.value)}/></label><button className="secondary-button" type="submit" data-testid="compensation-cancel">{t(pending?"cancelling":uncertain?"retryCancel":"cancel")}</button></fieldset>
  </form>;
}
