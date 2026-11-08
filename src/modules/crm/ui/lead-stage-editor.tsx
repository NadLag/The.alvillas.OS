"use client";
import {useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {leadWorkspaceItemSchema,leadWorkspaceOptionsSchema} from "../domain/lead-workspace";
import {leadStageSchema,type LeadStageDraft} from "../domain/lead-pipeline";
export function LeadStageEditor({lead,options,disabled,onReview}:{lead:z.infer<typeof leadWorkspaceItemSchema>;options:z.infer<typeof leadWorkspaceOptionsSchema>;disabled:boolean;onReview:(draft:LeadStageDraft,reason:string)=>void}){
  const t=useTranslations("LeadWorkspace"),edges=options.transitions.filter(edge=>edge.from===lead.stage),[selected,setSelected]=useState(""),[reason,setReason]=useState(""),edge=edges.find(item=>item.to===selected);
  const submit=(event:FormEvent)=>{event.preventDefault();if(!edge||edge.evidence.length||!reason.trim())return;onReview({leadId:lead.id,previousRevisionId:lead.stageRevisionId,toStage:leadStageSchema.parse(selected),evidenceReferences:[]},reason.trim());};
  if(!lead.canEdit||!edges.length)return null;
  return <form className="resource-form" onSubmit={submit} data-testid="lead-stage-editor"><fieldset disabled={disabled}><legend>{t("advanceStage")}</legend><label className="field"><span>{t("currentStage")}</span><select name="nextStage" required value={selected} onChange={event=>setSelected(event.target.value)}><option value="">{t("choose")}</option>{edges.map(item=><option key={item.to} value={item.to} disabled={item.evidence.length>0}>{t("stages."+item.to)}</option>)}</select></label><label className="field"><span>{t("stageReason")}</span><textarea name="stageReason" autoComplete="off" maxLength={1000} required rows={2} value={reason} onChange={event=>setReason(event.target.value)}/></label>{edges.some(item=>item.evidence.length>0)&&<p>{t("evidenceNeeded")}</p>}<button className="secondary-button" type="submit" disabled={!edge||edge.evidence.length>0||!reason.trim()}>{t("advanceStage")}</button></fieldset></form>;
}
