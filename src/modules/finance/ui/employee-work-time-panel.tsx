"use client";
import { useCallback,useState } from "react";
import { useFormatter,useTranslations } from "next-intl";
import { z } from "zod";
import { employeeWorkTimeViewSchema,employeeWorkTimeReceiptSchema,employeeWorkTimeSubmitSchema,employeeWorkTimeDecisionSchema } from "../domain/employee-work-time";
import { useCompensationRead } from "./use-compensation-read";
import { useCompensationCommand } from "./use-compensation-command";

const receiptSchema=employeeWorkTimeReceiptSchema.transform(value=>({...value,requestId:value.operation==="SUBMISSION"?value.evidence.id:value.evidence.decision!.id,state:"SUCCEEDED" as const,failureCode:null}));
const recoverySchema=z.object({receipt:employeeWorkTimeReceiptSchema.nullable()}).strict().transform(value=>({request:value.receipt?receiptSchema.parse(value.receipt):null}));
type Receipt=z.infer<typeof receiptSchema>;
type Entry={key:string;startsAt:string;endsAt:string;note:string};
const initialEntry=():Entry=>({key:"initial",startsAt:"",endsAt:"",note:""});

export function EmployeeWorkTimePanel({taskId,scope}:{taskId:string;scope:string}){
 const t=useTranslations("WorkTime"),format=useFormatter(),[beforeVersion,setBeforeVersion]=useState<number|undefined>(),[entries,setEntries]=useState<Entry[]>([initialEntry()]),[reason,setReason]=useState(""),[kind,setKind]=useState<"ACTUAL_INTERVALS"|"CANCELLATION">("ACTUAL_INTERVALS"),[decisionReason,setDecisionReason]=useState(""),[validation,setValidation]=useState(false);
 const read=useCompensationRead("/api/operations/work-time/read",employeeWorkTimeViewSchema,undefined,JSON.stringify({taskId,...beforeVersion?{beforeVersion}:{}}));
 const {clear,refresh}=read;
 const invalidate=useCallback(()=>clear(navigator.onLine?"forbidden":"offline"),[clear]),completed=useCallback(()=>{setEntries([initialEntry()]);setReason("");setDecisionReason("");setBeforeVersion(undefined);void refresh();},[refresh]);
 const acceptSubmit=useCallback((receipt:Receipt,input:z.infer<typeof employeeWorkTimeSubmitSchema>|null,nonce:string|null)=>receipt.taskId===taskId&&receipt.operation==="SUBMISSION"&&receipt.idempotencyKey===nonce&&(!input||receipt.evidence.previousEvidenceId===input.previousEvidenceId&&receipt.evidence.kind===input.kind&&receipt.evidence.reason===input.reason&&JSON.stringify(receipt.evidence.intervals)===JSON.stringify(input.intervals)),[taskId]);
 const acceptDecision=useCallback((receipt:Receipt,input:z.infer<typeof employeeWorkTimeDecisionSchema>|null,nonce:string|null)=>receipt.taskId===taskId&&receipt.operation==="DECISION"&&receipt.idempotencyKey===nonce&&(!input||receipt.evidence.id===input.evidenceId&&receipt.evidence.decision?.verdict===input.verdict&&receipt.evidence.decision?.reason===input.reason),[taskId]);
 const submissionRecovery=useCallback((key:string)=>({taskId,key,operation:"SUBMISSION"}),[taskId]),decisionRecovery=useCallback((key:string)=>({taskId,key,operation:"DECISION"}),[taskId]);
 const submission=useCompensationCommand({storageKey:"alvillas.work-time.submission.v1."+scope,inputSchema:employeeWorkTimeSubmitSchema,receiptSchema,recoverySchema,requestPath:"/api/operations/work-time/submit",recoveryPath:"/api/operations/work-time/recover",recoveryInput:submissionRecovery,accept:acceptSubmit,onSuccess:completed,onInvalidate:invalidate});
 const decision=useCompensationCommand({storageKey:"alvillas.work-time.decision.v1."+scope,inputSchema:employeeWorkTimeDecisionSchema,receiptSchema,recoverySchema,requestPath:"/api/operations/work-time/decide",recoveryPath:"/api/operations/work-time/recover",recoveryInput:decisionRecovery,accept:acceptDecision,onSuccess:completed,onInvalidate:invalidate});
 const edit=(key:string,field:"startsAt"|"endsAt"|"note",value:string)=>setEntries(rows=>rows.map(row=>row.key===key?{...row,[field]:value}:row));
 const model=read.data,latest=model?.items.find(row=>row.id===model.latestEvidenceId),busy=[submission,decision].some(command=>["sending","checking"].includes(command.state));
 const feedback=(command:typeof submission|typeof decision)=><>
  {command.error?<p role="alert">{t.has(command.error)?t(command.error):t("unavailable")}</p>:null}
  {command.state==="uncertain"?<button type="button" className="button button--secondary" onClick={()=>void command.send()}>{t("retryExact")}</button>:null}
  {command.state==="recoveryUnavailable"?<button type="button" className="button button--secondary" onClick={()=>void command.recover()}>{t("recover")}</button>:null}
 </>;
 return <section className="panel resource-form" data-testid="work-time-panel" aria-busy={read.pending||busy}>
  <h2>{t("title")}</h2><p>{t("guidance")}</p>
  {read.pending?<p role="status">{t("loading")}</p>:null}
  {read.error?<><p role="alert">{t.has(read.error)?t(read.error):t("unavailable")}</p><button type="button" className="button button--secondary" onClick={()=>void read.refresh()}>{t("refresh")}</button></>:null}
  {model?<><p>{t("completedAt",{at:format.dateTime(new Date(model.completedAt),{dateStyle:"medium",timeStyle:"long",timeZone:"UTC"})})}</p>
   {!model.policy?<p role="status">{t("configuration_unavailable")}</p>:null}
   {model.canSubmit&&model.policy?<form className="resource-form" onSubmit={event=>{event.preventDefault();setValidation(false);try{
    const intervals=kind==="CANCELLATION"?[]:entries.map(row=>({startsAt:new Date(row.startsAt+"Z").toISOString(),endsAt:new Date(row.endsAt+"Z").toISOString(),note:row.note.trim()||null}));
    const draft={taskId,previousEvidenceId:model.latestEvidenceId,kind,intervals,reason};if(!employeeWorkTimeSubmitSchema.safeParse({...draft,idempotencyKey:crypto.randomUUID()}).success){setValidation(true);return;}void submission.send(draft);
   }catch{setValidation(true);}}}>
    <fieldset className="resource-form" disabled={busy||submission.state!=="ready"}><legend>{t(model.latestEvidenceId?"newVersion":"record")}</legend>
     {model.latestEvidenceId?<label className="field"><span>{t("kind")}</span><select value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="ACTUAL_INTERVALS">{t("ACTUAL_INTERVALS")}</option><option value="CANCELLATION">{t("CANCELLATION")}</option></select></label>:null}
     {kind==="ACTUAL_INTERVALS"?entries.map((row,index)=><fieldset className="resource-form" key={row.key}><legend>{t("interval",{number:index+1})}</legend><div className="form-grid two">
      <label className="field"><span>{t("startsAt")}</span><input type="datetime-local" step="0.001" dir="ltr" value={row.startsAt} onChange={event=>edit(row.key,"startsAt",event.target.value)} required data-testid={"work-time-start-"+index}/></label>
      <label className="field"><span>{t("endsAt")}</span><input type="datetime-local" step="0.001" dir="ltr" value={row.endsAt} onChange={event=>edit(row.key,"endsAt",event.target.value)} required data-testid={"work-time-end-"+index}/></label>
     </div><label className="field"><span>{t("note")}</span><input value={row.note} maxLength={1000} onChange={event=>edit(row.key,"note",event.target.value)}/></label>
      {entries.length>1?<button className="button button--secondary" type="button" onClick={()=>setEntries(rows=>rows.filter(item=>item.key!==row.key))}>{t("removeInterval",{number:index+1})}</button>:null}
     </fieldset>):null}
     {kind==="ACTUAL_INTERVALS"&&entries.length<1000?<button className="button button--secondary" type="button" onClick={()=>setEntries(rows=>[...rows,{...initialEntry(),key:crypto.randomUUID()}])}>{t("addInterval")}</button>:null}
     <label className="field"><span>{t("reason")}</span><textarea value={reason} onChange={event=>setReason(event.target.value)} minLength={6} maxLength={1000} required data-testid="work-time-reason"/></label>
     <button className="button" type="submit" data-testid="work-time-submit">{t("submit")}</button>
    </fieldset>
    {validation?<p role="alert">{t("validation")}</p>:null}{feedback(submission)}
    {submission.state==="succeeded"?<><p role="status">{t("saved")}</p><button type="button" className="button button--secondary" onClick={()=>submission.startNew()}>{t("newVersion")}</button></>:null}
   </form>:null}
   {latest&&!latest.decision&&model.canValidate?<form className="resource-form" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void decision.send({taskId,evidenceId:latest.id,verdict:form.get("verdict")==="REJECTED"?"REJECTED":"APPROVED",reason:decisionReason});}}>
    <fieldset className="resource-form" disabled={busy||decision.state!=="ready"}><legend>{t("validate")}</legend>
     <label className="field"><span>{t("verdict")}</span><select name="verdict"><option value="APPROVED">{t("APPROVED")}</option><option value="REJECTED">{t("REJECTED")}</option></select></label>
     <label className="field"><span>{t("validationReason")}</span><textarea value={decisionReason} onChange={event=>setDecisionReason(event.target.value)} required minLength={6} maxLength={1000} data-testid="work-time-decision-reason"/></label>
     <button className="button" type="submit" data-testid="work-time-decide">{t("validate")}</button>
    </fieldset>{feedback(decision)}{decision.state==="succeeded"?<button type="button" className="button button--secondary" onClick={()=>decision.startNew()}>{t("newDecision")}</button>:null}
   </form>:null}
   <h3>{t("history")}</h3>{model.items.length?<ol>{model.items.map(row=><li key={row.id} data-testid="work-time-history"><p>{t("version",{version:row.version})} · {t(row.kind)} · {row.decision?t(row.decision.verdict):t("awaitingValidation")}</p><p>{row.reason}</p><ul>{row.intervals.map((interval,index)=><li key={index}>{format.dateTime(new Date(interval.startsAt),{dateStyle:"medium",timeStyle:"long",timeZone:"UTC"})} — {format.dateTime(new Date(interval.endsAt),{dateStyle:"medium",timeStyle:"long",timeZone:"UTC"})}{interval.note?<p>{interval.note}</p>:null}</li>)}</ul>{row.decision?<p>{row.decision.reason}</p>:null}</li>)}</ol>:<p>{t("empty")}</p>}
   {model.next?<button type="button" className="button button--secondary" onClick={()=>setBeforeVersion(model.next!)}>{t("earlier")}</button>:null}{beforeVersion?<button type="button" className="button button--secondary" onClick={()=>setBeforeVersion(undefined)}>{t("latest")}</button>:null}
  </>:null}
 </section>;
}
