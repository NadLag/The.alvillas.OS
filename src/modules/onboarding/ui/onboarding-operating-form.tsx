"use client";
import {useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import {onboardingOperatingCadences} from "@/platform/onboarding/contracts";
import {canonicalOnboardingOperatingDraft,type OnboardingOperatingDraft,type OnboardingOperatingProfile} from "../domain/onboarding-operating-profile";
import {onboardingMaximumRequestBytes} from "../domain/onboarding-wizard";
import {OnboardingOperatingValues,operatingBooleanFields,operatingCadenceFields} from "./onboarding-operating-record";

type Update=Extract<OnboardingOperatingDraft["target"],{mode:"UPDATE"}>["input"];
type Props={sessionId:string;previousRevisionId:string;propertyId:string;propertyName:string;modes:("LINK"|"UPDATE")[];profile:OnboardingOperatingProfile|null;disabled:boolean;initialInput?:Update;initialMode?:"LINK"|"UPDATE";initialReason?:string;onReview:(draft:OnboardingOperatingDraft,reason:string)=>void;onCancel:()=>void};
export function OnboardingOperatingForm({sessionId,previousRevisionId,propertyId,propertyName,modes,profile,disabled,initialInput,initialMode,initialReason,onReview,onCancel}:Props){
 const t=useTranslations("OnboardingWizard"),c=useTranslations("Core.properties.operating"),common=useTranslations("Core.common"),[mode,setMode]=useState<"LINK"|"UPDATE">(initialMode&&modes.includes(initialMode)?initialMode:modes[0]??"LINK"),[invalid,setInvalid]=useState(false),seed=initialInput??profile;
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setInvalid(false);try{
  const fields=new FormData(event.currentTarget),text=(key:string)=>{const value=fields.get(key);return typeof value==="string"?value:"";},reason=text("reason").trim();if(!reason||reason.length>1000)throw Error("reason_required");
  const input=mode==="UPDATE"?{...Object.fromEntries(operatingBooleanFields.map(([field])=>{const value=text(field);if(value!=="true"&&value!=="false")throw Error("explicit_choice_required");return[field,value==="true"];})),...Object.fromEntries(operatingCadenceFields.map(([field])=>[field,text(field)])),midStayCleaningRuleKey:text("midStayCleaningRuleKey"),automationNotes:text("automationNotes"),otherServices:text("otherServices").split(/\r?\n/u).map(value=>value.trim()).filter(Boolean)}:undefined,draft=canonicalOnboardingOperatingDraft({sessionId,previousRevisionId,step:"OPERATING_PROFILE",target:mode==="LINK"?{mode,propertyId}:{mode,propertyId,input}});
  if(new TextEncoder().encode(JSON.stringify({...draft,idempotencyKey:crypto.randomUUID(),reviewFingerprint:"0".repeat(64),reason})).byteLength>onboardingMaximumRequestBytes)throw Error("request_size");onReview(draft,reason);
 }catch{setInvalid(true);}};
 return <form className="resource-form" data-testid="onboarding-operating-form" onSubmit={submit}><fieldset className="resource-form" disabled={disabled}><legend>{t("steps.OPERATING_PROFILE")}</legend>
  <p>{t("operating.guidance")}</p><p dir="auto"><strong>{propertyName}</strong></p>{invalid&&<p className="form-error" role="alert">{t("operating.validation")}</p>}
  <label className="field"><span>{t("operating.mode")}</span><select name="mode" value={mode} onChange={event=>{setMode(event.target.value as "LINK"|"UPDATE");setInvalid(false);}}>{modes.map(value=><option key={value} value={value}>{t("operating.modes."+value)}</option>)}</select></label>
  {mode==="LINK"?<OnboardingOperatingValues profile={profile}/>:<div key="explicit-operating-choices" className="resource-form">
   {operatingBooleanFields.map(([field,label])=><label className="field" key={field}><span>{c(label)}</span><select name={field} required defaultValue={seed?String(seed[field]):""}><option value="">{t("operating.choose")}</option><option value="true">{common("yes")}</option><option value="false">{common("no")}</option></select></label>)}
   {operatingCadenceFields.map(([field,label])=><label className="field" key={field}><span>{c(label)} · {c("cadence")}</span><select name={field} required defaultValue={seed?.[field]??""}><option value="">{t("operating.choose")}</option>{onboardingOperatingCadences.map(value=><option key={value} value={value}>{c("cadenceOptions."+value)}</option>)}</select></label>)}
   <label className="field"><span>{c("midStayRuleKey")}</span><input name="midStayCleaningRuleKey" dir="ltr" autoComplete="off" defaultValue={seed?.midStayCleaningRuleKey??""}/></label>
   <label className="field"><span>{c("otherServices")}</span><textarea name="otherServices" rows={4} autoComplete="off" defaultValue={seed?.otherServices.join("\n")??""}/><span className="field-help">{t("operating.servicesHint")}</span></label>
   <label className="field"><span>{c("automationNotes")}</span><textarea name="automationNotes" rows={5} autoComplete="off" defaultValue={seed?.automationNotes??""}/></label>
  </div>}
  <label className="field"><span>{t("reason")}</span><textarea name="reason" required maxLength={1000} rows={3} autoComplete="off" defaultValue={initialReason??""}/></label>
  <div className="form-actions"><button type="submit" className="primary-button" data-testid="onboarding-operating-review" disabled={!modes.includes(mode)||mode==="LINK"&&profile===null}>{t("review")}</button><button type="button" className="secondary-button" onClick={onCancel}>{t("cancel")}</button></div>
 </fieldset></form>;
}
