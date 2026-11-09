"use client";
import {useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import type {leadWorkspaceItemSchema,leadWorkspaceOptionsSchema} from "../domain/lead-workspace";
import {leadStageSchema,leadPipelineEvidenceKinds,type LeadStageDraft} from "../domain/lead-pipeline";
import type {LeadStageEvidenceChoices,LeadStageEvidenceChoicesInput} from "../domain/lead-stage-evidence-choices";

export type StageEvidenceSelection={input:LeadStageEvidenceChoicesInput;result:LeadStageEvidenceChoices};
type Reference=NonNullable<LeadStageDraft["evidenceReferences"]>[number];
export function LeadStageEditor({lead,options,locale,disabled,evidence,onChoices,onClear,onReview}:{lead:z.infer<typeof leadWorkspaceItemSchema>;options:z.infer<typeof leadWorkspaceOptionsSchema>;locale:AppLocale;disabled:boolean;evidence:StageEvidenceSelection|null;onChoices:(input:LeadStageEvidenceChoicesInput)=>void;onClear:()=>void;onReview:(draft:LeadStageDraft,reason:string)=>void}){
 const t=useTranslations("LeadWorkspace"),edges=options.transitions.filter(edge=>edge.from===lead.stage),[selected,setSelected]=useState(""),[reason,setReason]=useState(""),[references,setReferences]=useState<Reference[]>([]),[labels,setLabels]=useState<string[]>([]),edge=edges.find(item=>item.to===selected),required=leadPipelineEvidenceKinds.filter(kind=>edge?.evidence.includes(kind)),draft=edge?{leadId:lead.id,previousRevisionId:lead.stageRevisionId,toStage:leadStageSchema.parse(selected),evidenceReferences:references}:null;
 const matching=evidence&&draft&&evidence.result.leadId===lead.id&&evidence.result.previousRevisionId===lead.stageRevisionId&&evidence.result.toStage===selected&&JSON.stringify(evidence.result.selected)===JSON.stringify(references)&&JSON.stringify(evidence.result.required)===JSON.stringify(required)?evidence:null;
 const date=(value:string)=>new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
 const submit=(event:FormEvent)=>{event.preventDefault();if(!draft||references.length!==required.length||!reason.trim())return;onReview(draft,reason.trim());};
 const clear=()=>{setReferences([]);setLabels([]);onClear();};
 if(!lead.canEdit||!edges.length)return null;
 return <form className="resource-form lead-stage-editor" onSubmit={submit} data-testid="lead-stage-editor"><fieldset className="resource-form" disabled={disabled}><legend>{t("advanceStage")}</legend><label className="field"><span>{t("nextStage")}</span><select name="nextStage" required value={selected} onChange={event=>{setSelected(event.target.value);clear();}}><option value="">{t("choose")}</option>{edges.map(item=><option key={item.to} value={item.to}>{t("stages."+item.to)}</option>)}</select></label>
  {required.length>0&&<section className="resource-form" data-testid="lead-stage-evidence"><h3>{t("evidence.title")}</h3><p>{t("evidence.guidance")}</p><ol>{references.map((reference,index)=><li key={reference.kind}><span>{t("evidence.kinds."+reference.kind)}{labels[index]?" · "+labels[index]:""}</span><button type="button" className="quiet-button" aria-label={t("evidence.changeKind",{kind:t("evidence.kinds."+reference.kind)})} onClick={()=>{setReferences(value=>value.slice(0,index));setLabels(value=>value.slice(0,index));onClear();}}>{t("evidence.change")}</button></li>)}</ol>
   {references.length<required.length&&draft&&<><p>{t("evidence.next",{kind:t("evidence.kinds."+required[references.length])})}</p><button type="button" className="secondary-button" data-testid="lead-stage-find-evidence" onClick={()=>onChoices(draft)}>{t("evidence.find")}</button></>}
   {matching&&<div className="resource-form" data-testid="lead-stage-evidence-choices">{matching.result.dependency?<p role="status">{t("evidence.onboardingRequired")}</p>:!matching.result.items.length?<p>{t("evidence.empty")}</p>:<ul className="lead-directory-list">{matching.result.items.map(item=><li key={item.kind+":"+item.id}><button type="button" className="quiet-button" data-testid="lead-stage-evidence-choice" onClick={()=>{
    if(!draft)return;if(item.kind==="DOCUMENT")onChoices({...draft,documentId:item.id});else if(item.kind==="SIGNATURE")onChoices({...draft,signatureId:item.id});else if(item.evidenceKind===required[references.length]){setReferences(value=>[...value,{kind:item.evidenceKind,sourceId:item.id}]);setLabels(value=>[...value,item.title??date(item.occurredAt)]);onClear();}
   }}>{item.kind==="DOCUMENT"?<><span dir="auto">{item.title}</span><span>{t("evidence.language",{locale:item.locale.toUpperCase()})}</span></>:item.kind==="SIGNATURE"?<><span>{t("evidence.signatureStates."+item.state)}</span><span>{date(item.createdAt)}</span></>:<><span>{item.title??t("evidence.kinds."+item.evidenceKind)}</span>{item.number&&<span>{t("evidence.version",{number:item.number})}</span>}<span>{date(item.occurredAt)}</span></>}</button></li>)}</ul>}{matching.result.next&&<button type="button" className="secondary-button" onClick={()=>onChoices({...matching.input,cursor:matching.result.next!})} data-testid="lead-stage-evidence-more">{t("more")}</button>}</div>}
   {references.length===required.length&&<p data-testid="lead-stage-evidence-complete">{t("evidence.ready")}</p>}
  </section>}
  <label className="field"><span>{t("stageReason")}</span><textarea name="stageReason" autoComplete="off" maxLength={1000} required rows={2} value={reason} onChange={event=>setReason(event.target.value)}/></label><button className="secondary-button" type="submit" disabled={!edge||references.length!==required.length||!reason.trim()}>{t("advanceStage")}</button>
 </fieldset></form>;
}
