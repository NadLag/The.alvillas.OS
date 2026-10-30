"use client";
import { useCallback,useEffect,useRef,useState,type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { EmptyState,SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate,formatDateTime } from "@/i18n/format";
import { localizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationRunCreateSchema,employeeCompensationRunViewSchema } from "../domain/employee-compensation-run";
import { employeeCompensationEditorSchema,employeeCompensationWorkSchema } from "../domain/employee-compensation-picker";
import { useCompensationRead,type CompensationReadError } from "./use-compensation-read";

const storagePrefix="alvillas.compensation.pending.v1.",receiptSchema=employeeCompensationRunViewSchema.extend({idempotent:z.boolean()}),recoverySchema=z.object({run:employeeCompensationRunViewSchema.nullable()}).strict();
type Job={taskId:string;assignmentId:string;confirmedAssignment:true};
type Filters={fromOn:string;toOn:string;currency:string};
const storedNonce=(key:string)=>{try{const parsed=z.uuid().safeParse(sessionStorage.getItem(key));return parsed.success?parsed.data:null;}catch{return null;}};
const storeNonce=(key:string,value:string)=>{try{sessionStorage.setItem(key,value);}catch{/* The current tab still retains the exact in-memory command. */}};
const clearNonce=(key:string,value:string)=>{try{if(sessionStorage.getItem(key)===value)sessionStorage.removeItem(key);}catch{/* Access to browser storage is optional. */}};

export function CompensationRunCreate({locale,recoveryScope}:{locale:AppLocale;recoveryScope:string}){
  const storageKey=storagePrefix+recoveryScope;
  const t=useTranslations("CompensationRuns"),router=useRouter(),[recovery,setRecovery]=useState<"checking"|"ready"|"failed"|"forbidden">("checking");
  const [filters,setFilters]=useState<Filters|null>(null),[after,setAfter]=useState<string|undefined>(),[selected,setSelected]=useState<Record<string,Job>>({}),[purpose,setPurpose]=useState(""),[reason,setReason]=useState("");
  const [pending,setPending]=useState(false),[uncertain,setUncertain]=useState(false),[commandError,setCommandError]=useState<string|null>(null),[boundCount,setBoundCount]=useState(0);
  const nonce=useRef<string|null>(null),intent=useRef<z.infer<typeof employeeCompensationRunCreateSchema>|null>(null),inFlight=useRef(false),alive=useRef(true);
  const invalidate=useCallback(()=>setSelected({}),[]);
  const editor=useCompensationRead(recovery==="ready"?"/api/finance/compensation/runs/editor":null,employeeCompensationEditorSchema,invalidate);
  const effective=filters??(editor.data?{fromOn:editor.data.date,toOn:editor.data.date,currency:editor.data.currencies.includes(editor.data.baseCurrency)?editor.data.baseCurrency:editor.data.currencies[0]??""}:null);
  const query=effective?new URLSearchParams(effective):null;if(query&&after)query.set("after",after);
  const work=useCompensationRead(recovery==="ready"&&editor.data&&query?`/api/finance/compensation/runs/work?${query}`:null,employeeCompensationWorkSchema,invalidate);
  const recover=useCallback(async(key:string)=>{
    setRecovery("checking");
    try{
      const response=await fetch("/api/finance/compensation/runs/recover",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({key})});
      if(!alive.current)return;
      if(response.status===401||response.status===403){setRecovery("forbidden");return;}
      if(!response.ok)throw Error("Recovery unavailable");
      const result=recoverySchema.parse(await response.json());if(!alive.current)return;
      if(result.run){clearNonce(storageKey,key);router.replace(`/${locale}/app/finance/compensation/${result.run.id}`);return;}
      // Retain an unmatched nonce: a delayed original request and a new intent still cannot create two runs.
      setRecovery("ready");
    }catch{if(alive.current)setRecovery("failed");}
  },[locale,router,storageKey]);
  useEffect(()=>{
    let disposed=false;alive.current=true;
    queueMicrotask(()=>{if(disposed)return;const previous=storedNonce(storageKey);nonce.current=previous;if(previous)void recover(previous);else setRecovery("ready");});
    return()=>{disposed=true;alive.current=false;};
  },[recover,storageKey]);
  const unavailable=editor.error??(work.error==="validation"||work.error==="configuration_unavailable"?null:work.error);
  const retry=()=>{if(nonce.current&&recovery!=="ready"){void recover(nonce.current);return;}void editor.refresh();void work.refresh();};
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(inFlight.current||!effective||!editor.data||!navigator.onLine)return;
    nonce.current??=crypto.randomUUID();
    const parsed=employeeCompensationRunCreateSchema.safeParse(intent.current??{...effective,purpose,reason,idempotencyKey:nonce.current,jobs:Object.values(selected)});
    if(!parsed.success){setCommandError("validation");return;}
    intent.current=parsed.data;storeNonce(storageKey,parsed.data.idempotencyKey);setBoundCount(parsed.data.jobs.length);inFlight.current=true;setPending(true);setCommandError(null);
    try{
      const response=await fetch("/api/finance/compensation/runs",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(parsed.data)});
      if(!alive.current)return;
      if(response.status===401||response.status===403){setSelected({});setPurpose("");setReason("");intent.current=null;setRecovery("forbidden");return;}
      if(!response.ok){setUncertain(true);if(response.status===409){const body:unknown=await response.json();setCommandError(body&&typeof body==="object"&&"error" in body&&body.error==="configuration_unavailable"?"configuration_unavailable":"creationConflict");}else setCommandError("creationUncertain");return;}
      const result=receiptSchema.parse(await response.json());
      if(result.lineCount!==parsed.data.jobs.length||result.purpose!==parsed.data.purpose||result.fromOn!==parsed.data.fromOn||result.toOn!==parsed.data.toOn||result.currency!==parsed.data.currency||result.lines.some(line=>!parsed.data.jobs.some(job=>job.taskId===line.taskId&&job.assignmentId===line.assignmentId)))throw Error("Creation acknowledgement does not match the immutable intent");
      clearNonce(storageKey,parsed.data.idempotencyKey);router.replace(`/${locale}/app/finance/compensation/${result.id}`);
    }catch{if(alive.current){setUncertain(true);setCommandError("creationUncertain");}}
    finally{inFlight.current=false;if(alive.current)setPending(false);}
  }
  if(recovery==="checking"||editor.pending)return <div role="status"><p>{t(recovery==="checking"?"recovering":"loading")}</p><SkeletonBlock rows={4}/></div>;
  if(recovery==="failed"||recovery==="forbidden"||unavailable)return <div role="alert" className="compensation-notice" data-testid="compensation-create-error"><p>{t(recovery==="forbidden"?"forbidden":recovery==="failed"?"recoveryUnavailable":unavailable as CompensationReadError)}</p><button className="secondary-button" type="button" onClick={retry}>{t("retryRead")}</button></div>;
  if(!editor.data||!effective)return <EmptyState>{t("unavailable")}</EmptyState>;
  const changeFilters=(next:Filters)=>{setFilters(next);setAfter(undefined);setSelected({});};
  const selectedCount=uncertain?boundCount:Object.keys(selected).length;
  return <form className="compensation-create-form" data-testid="compensation-create-form" aria-busy={pending} onSubmit={event=>{void submit(event);}}>
    <fieldset className="resource-form" disabled={pending||uncertain}><legend>{t("earningWindow")}</legend><p>{t("windowGuidance",{timezone:editor.data.timezone,days:editor.data.maxPeriodDays})}</p><div className="form-grid two">
      <label className="field"><span>{t("fromOn")}</span><input type="date" data-testid="compensation-from" value={effective.fromOn} onChange={event=>changeFilters({...effective,fromOn:event.target.value})} required/></label>
      <label className="field"><span>{t("toOn")}</span><input type="date" data-testid="compensation-to" value={effective.toOn} min={effective.fromOn} onChange={event=>changeFilters({...effective,toOn:event.target.value})} required/></label>
      <label className="field"><span>{t("currency")}</span><select data-testid="compensation-currency" value={effective.currency} onChange={event=>changeFilters({...effective,currency:event.target.value})} required>{editor.data.currencies.map(code=><option key={code} value={code}>{code}</option>)}</select></label>
    </div></fieldset>
    <fieldset className="compensation-work-picker" disabled={pending||uncertain||work.pending}><legend>{t("chooseWork")}</legend><p>{t("choiceGuidance")}</p>
      {work.pending?<p role="status">{t("loadingWork")}</p>:null}
      {work.error?<p role="alert" data-testid="compensation-work-error">{t(work.error)}</p>:null}
      {work.data?.items.length===0?<EmptyState testId="compensation-work-empty">{t("noEligibleWork")}</EmptyState>:null}
      {work.data?.items.map(item=><fieldset className="compensation-source" key={item.taskId} data-testid="compensation-work-item"><legend>{item.choices[0].sourceTitle?localizedText(item.choices[0].sourceTitle,locale):t("completedWork")}</legend><p>{formatDateTime(locale,new Date(item.recordedCompletionAt),{timeZone:work.data!.timezone})}</p>
        {item.choices.map(choice=><label className="compensation-contract-choice" key={choice.assignmentId}><input type="radio" name={item.taskId} data-testid={`compensation-choice-${choice.assignmentId}`} checked={selected[item.taskId]?.assignmentId===choice.assignmentId} onChange={()=>setSelected(current=>({...current,[item.taskId]:{taskId:item.taskId,assignmentId:choice.assignmentId,confirmedAssignment:true}}))}/><span><strong dir="auto">{choice.personName??t("restrictedPerson")}</strong><span dir="auto">{choice.propertyName??t("restrictedProperty")}</span><span dir="auto">{choice.roleName}</span><small>{t("contractVersion",{version:choice.contractVersion,at:formatDate(locale,new Date(choice.effectiveFrom),{timeZone:"UTC"})})}</small><strong>{t("perJob",{amount:formatCurrencyAmount(locale,choice.rate.amount,choice.rate.currency)})}</strong><small>{t(`methods.${choice.completionMethod}`)}{choice.completionMethod==="PROXY"?` · ${t("validator")}: ${choice.validatorName??t("restrictedPerson")}`:""}</small></span></label>)}
        {selected[item.taskId]?<button className="quiet-button" type="button" onClick={()=>setSelected(current=>Object.fromEntries(Object.entries(current).filter(([id])=>id!==item.taskId)))}>{t("removeWork")}</button>:null}
      </fieldset>)}
      <div className="app-actions">{after?<button type="button" className="secondary-button" onClick={()=>setAfter(undefined)}>{t("firstSources")}</button>:null}{work.data?.next?<button type="button" className="secondary-button" data-testid="compensation-work-next" onClick={()=>setAfter(work.data!.next!)}>{t("nextSources")}</button>:null}</div>
    </fieldset>
    <fieldset className="resource-form" disabled={pending||uncertain}><legend>{t("runDetails")}</legend><div className="form-grid"><label className="field"><span>{t("purpose")}</span><textarea data-testid="compensation-create-purpose" value={purpose} onChange={event=>setPurpose(event.target.value)} minLength={3} maxLength={1000} required dir="auto"/></label><label className="field"><span>{t("creationReason")}</span><textarea data-testid="compensation-create-reason" value={reason} onChange={event=>setReason(event.target.value)} minLength={6} maxLength={500} required dir="auto"/></label></div></fieldset>
    <div className="compensation-create-review"><p role="status" data-testid="compensation-selected-count">{t("selectedCount",{count:selectedCount})}</p><p>{t("creationGuidance")}</p>
      {commandError?<p role="alert" data-testid="compensation-command-error">{t(commandError)}</p>:null}
      <button className="primary-button" type="submit" disabled={pending||work.pending||(!work.data&&!uncertain)||selectedCount===0} data-testid="compensation-create">{t(pending?"creating":uncertain?"retryCreate":"saveDraft")}</button>
      {uncertain?<button type="button" className="secondary-button" data-testid="compensation-recover" onClick={()=>{if(nonce.current)void recover(nonce.current);}}>{t("recoverSaved")}</button>:null}
    </div>
  </form>;
}
