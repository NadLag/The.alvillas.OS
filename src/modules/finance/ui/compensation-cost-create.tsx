"use client";
import { useCallback,useState,type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate,formatDateTime } from "@/i18n/format";
import { localizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationCostWorkspaceSchema } from "../domain/employee-compensation-cost-workspace";
import { employeeCompensationRunDetailSchema } from "../domain/employee-compensation-workspace";
import { useCompensationRead } from "./use-compensation-read";
import { useCompensationCostCommand } from "./use-compensation-cost-command";

type Classification={category:string;costCenter:string;note:string};
const blank=():Classification=>({category:"",costCenter:"",note:""});

export function CompensationCostCreate({locale,runId,recoveryScope}:{locale:AppLocale;runId:string;recoveryScope:string}){
  const t=useTranslations("CompensationCosts"),sourceText=useTranslations("CompensationRuns");
  const [classification,setClassification]=useState<Classification>(blank),[overrides,setOverrides]=useState<Record<string,Classification>>({}),[costOn,setCostOn]=useState(""),[reason,setReason]=useState(""),[emergency,setEmergency]=useState(false),[after,setAfter]=useState<string>();
  const invalidate=useCallback(()=>{setClassification(blank());setOverrides({});setCostOn("");setReason("");setEmergency(false);},[]);
  const command=useCompensationCostCommand({locale,runId,scope:recoveryScope,onInvalidate:invalidate});
  const denyCommand=command.deny;
  const invalidateRead=useCallback(()=>{if(navigator.onLine)denyCommand();else invalidate();},[denyCommand,invalidate]);
  const readable=command.state==="ready"||command.state==="sending"||command.state==="uncertain";
  const workspace=useCompensationRead(readable?`/api/finance/compensation/runs/${runId}/cost-workspace`:null,employeeCompensationCostWorkspaceSchema,invalidateRead);
  const evidence=useCompensationRead(readable?`/api/finance/compensation/runs/${runId}/detail${after?`?${new URLSearchParams({after})}`:""}`:null,employeeCompensationRunDetailSchema,invalidateRead);
  const locked=command.state!=="ready",data=workspace.data,labels=new Map(evidence.data?.labels.map(label=>[label.lineId,label])??[]),positive=new Set(data?.positiveLineIds??[]);
  const error=workspace.error??evidence.error;
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!data)return;
    await command.send({runId,costOn,emergency,reason,costs:data.positiveLineIds.map(runLineId=>{const value=overrides[runLineId]??classification;return{runLineId,category:value.category,costCenter:value.costCenter.trim()||null,note:value.note};})});
  }
  if(!readable)return <div className="compensation-notice" data-testid="compensation-cost-command-state" aria-busy={command.state==="checking"||command.state==="pending"}>
    <p role={command.state==="forbidden"||command.error?"alert":"status"}>{t(command.state==="terminal"?`failures.${command.error}`:command.state)}</p>
    {command.state==="terminal"?<button className="secondary-button" type="button" onClick={command.startNew}>{t("startNew")}</button>:command.state!=="checking"&&command.state!=="pending"?<button className="secondary-button" type="button" onClick={()=>{void command.recover();}}>{t("recover")}</button>:null}
  </div>;
  if(error)return <div role="alert" className="compensation-notice"><p>{t(error)}</p><button className="secondary-button" onClick={()=>{void workspace.refresh();void evidence.refresh();}}>{t("retryRead")}</button></div>;
  if(!data||!evidence.data)return <div role="status"><p>{t("loading")}</p><SkeletonBlock rows={4}/></div>;
  if(!data.canPrepare&&command.state!=="uncertain")return <p role="status" className="compensation-notice">{t(`blocked.${data.blocked??"forbidden"}`)}</p>;
  return <form className="compensation-create-form" data-testid="compensation-cost-create-form" aria-busy={command.state==="sending"} onSubmit={event=>{void submit(event);}}>
    <section className="compensation-summary"><div><h2 dir="auto">{data.run.purpose}</h2><p>{t("prepareDescription")}</p></div><dl><div><dt>{t("originalTotal")}</dt><dd className="compensation-total" data-testid="compensation-cost-original-total">{formatCurrencyAmount(locale,data.run.total.amount,data.run.total.currency)}</dd></div><div><dt>{t("includedWork")}</dt><dd>{new Intl.NumberFormat(locale).format(data.positiveLineIds.length)}</dd></div></dl></section>
    <fieldset className="resource-form" disabled={locked}><legend>{t("classification")}</legend><p>{t("classificationGuidance")}</p><div className="form-grid two"><label className="field"><span>{t("costOn")}</span><input type="date" value={costOn} onChange={event=>setCostOn(event.target.value)} required data-testid="compensation-cost-date"/></label><ClassificationFields value={classification} onChange={setClassification}/></div></fieldset>
    <fieldset className="compensation-work-picker" disabled={locked}><legend>{t("sourceEvidence")}</legend><p>{t("sourceGuidance")}</p><ol className="compensation-source-list">{evidence.data.lines.map(line=>{
      const label=labels.get(line.id);if(!label)return null;const override=overrides[line.id];
      return <li className="compensation-source" key={line.id} data-testid="compensation-cost-work"><div className="compensation-source-heading"><div><h3>{label.sourceTitle?localizedText(label.sourceTitle,locale):sourceText("completedWork")}</h3><p dir="auto">{label.propertyName??sourceText("restrictedProperty")}</p></div><strong className="compensation-numeric">{formatCurrencyAmount(locale,line.amount.amount,line.amount.currency)}</strong></div><dl className="compensation-evidence"><div><dt>{sourceText("performer")}</dt><dd dir="auto">{label.personName??sourceText("restrictedPerson")}</dd></div><div><dt>{sourceText("contract")}</dt><dd dir="auto">{label.roleName}<small>{sourceText("contractVersion",{version:label.contractVersion,at:formatDate(locale,new Date(label.effectiveFrom),{timeZone:"UTC"})})}</small></dd></div><div><dt>{sourceText("completion")}</dt><dd>{sourceText(`methods.${label.completionMethod}`)}<small>{formatDateTime(locale,new Date(line.recordedCompletionAt),{timeZone:data.run.timezone})}</small></dd></div>{label.completionMethod==="PROXY"?<div><dt>{sourceText("validator")}</dt><dd dir="auto">{label.validatorName??sourceText("restrictedPerson")}</dd></div>:null}</dl>
        {positive.has(line.id)?<><label className="compensation-cost-check"><input type="checkbox" checked={Boolean(override)} onChange={event=>setOverrides(current=>event.target.checked?{...current,[line.id]:{...classification}}:Object.fromEntries(Object.entries(current).filter(([id])=>id!==line.id)))}/><span>{t("override")}</span></label>{override?<div className="form-grid two"><ClassificationFields value={override} onChange={value=>setOverrides(current=>({...current,[line.id]:value}))}/></div>:null}</>:<p>{t("zeroWork")}</p>}
      </li>;
    })}</ol><div className="app-actions">{after?<button className="secondary-button" type="button" onClick={()=>setAfter(undefined)}>{t("firstPage")}</button>:null}{evidence.data.nextCursor?<button className="secondary-button" type="button" onClick={()=>setAfter(evidence.data!.nextCursor!)} data-testid="compensation-cost-next-work">{t("nextPage")}</button>:null}</div></fieldset>
    <fieldset className="resource-form" disabled={locked}><legend>{t("submissionDetails")}</legend><label className="field"><span>{t("reason")}</span><textarea minLength={6} maxLength={500} required dir="auto" value={reason} onChange={event=>setReason(event.target.value)} data-testid="compensation-cost-reason"/></label><label className="compensation-cost-check"><input type="checkbox" checked={emergency} onChange={event=>setEmergency(event.target.checked)} data-testid="compensation-cost-emergency"/><span>{t("emergency")}</span></label><p>{t("emergencyGuidance")}</p></fieldset>
    <div className="compensation-create-review"><p>{t("submitGuidance")}</p>{command.error?<p role="alert" data-testid="compensation-cost-command-error">{t(command.error)}</p>:null}<button className="primary-button" disabled={command.state==="sending"} data-testid="compensation-cost-submit">{t(command.state==="sending"?"sending":command.state==="uncertain"?"retryExact":"submit")}</button>{command.state==="uncertain"?<button type="button" className="secondary-button" onClick={()=>{void command.recover();}} data-testid="compensation-cost-recover">{t("recover")}</button>:null}</div>
  </form>;
}

function ClassificationFields({value,onChange}:{value:Classification;onChange:(value:Classification)=>void}){
  const t=useTranslations("CompensationCosts");return <><label className="field"><span>{t("category")}</span><input value={value.category} maxLength={120} required dir="auto" onChange={event=>onChange({...value,category:event.target.value})} data-testid="compensation-cost-category"/></label><label className="field"><span>{t("costCenter")}</span><input value={value.costCenter} maxLength={120} dir="auto" onChange={event=>onChange({...value,costCenter:event.target.value})} data-testid="compensation-cost-center"/></label><label className="field"><span>{t("note")}</span><textarea value={value.note} minLength={6} maxLength={1000} required dir="auto" onChange={event=>onChange({...value,note:event.target.value})} data-testid="compensation-cost-note"/></label></>;
}
