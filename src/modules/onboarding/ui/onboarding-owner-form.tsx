"use client";
import {useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {canonicalOnboardingDraft,type OnboardingDraft,type onboardingChoicesSchema,type onboardingOptionsSchema} from "../domain/onboarding-wizard";

export type OnboardingOwnerChoice=z.infer<typeof onboardingChoicesSchema>["owners"][number];
type Options=z.infer<typeof onboardingOptionsSchema>;
type OwnerInput=Extract<OnboardingDraft["target"],{mode:"CREATE"}>["input"];
export function OnboardingOwnerForm({locale,sessionId,previousRevisionId,options,disabled,selectedOwner,choices,initialInput,initialReason,onSearch,onChoose,onClear,onReview,onCancel}:{locale:AppLocale;sessionId:string|null;previousRevisionId:string|null;options:Options;disabled:boolean;selectedOwner:OnboardingOwnerChoice|null;choices:z.infer<typeof onboardingChoicesSchema>|null;initialInput?:OwnerInput;initialReason?:string;onSearch:(query:string,append?:boolean)=>void;onChoose:(owner:OnboardingOwnerChoice)=>void;onClear:()=>void;onReview:(draft:OnboardingDraft,reason:string)=>void;onCancel:()=>void}){
 const t=useTranslations("OnboardingWizard"),[mode,setMode]=useState<"CREATE"|"LINK">(initialInput&&options.modes.includes("CREATE")?"CREATE":selectedOwner&&options.modes.includes("LINK")?"LINK":options.modes[0]??"CREATE"),[query,setQuery]=useState(""),[invalid,setInvalid]=useState(false);
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setInvalid(false);try{const fields=new FormData(event.currentTarget),text=(key:string)=>{const value=fields.get(key);return typeof value==="string"?value:"";},reason=text("reason").trim();if(!reason)throw Error("reason_required");const target=mode==="LINK"?{mode,ownerId:selectedOwner?.id}:{mode,input:{displayName:text("displayName"),legalName:text("legalName"),email:text("email"),phone:text("phone"),preferredLocale:text("preferredLocale"),notes:text("notes")}},draft=canonicalOnboardingDraft({sessionId,previousRevisionId,step:"OWNER",target});onReview(draft,reason);}catch{setInvalid(true);}};
 return <form className="resource-form onboarding-owner-form" data-testid="onboarding-owner-form" onSubmit={submit}><fieldset className="resource-form" disabled={disabled}><legend>{t("steps.OWNER")}</legend>
  {invalid&&<p className="form-error" role="alert">{t("states.validation")}</p>}
  <label className="field"><span>{t("ownerMode")}</span><select name="mode" value={mode} onChange={event=>{setMode(event.target.value as "CREATE"|"LINK");setQuery("");setInvalid(false);onClear();}}>{options.modes.map(value=><option key={value} value={value}>{t("modes."+value)}</option>)}</select></label>
  {mode==="CREATE"?<>
   <label className="field"><span>{t("fields.displayName")}</span><input name="displayName" required autoComplete="off" defaultValue={initialInput?.displayName??""}/></label>
   <label className="field"><span>{t("fields.legalName")}</span><input name="legalName" autoComplete="off" defaultValue={initialInput?.legalName??""}/></label>
   <label className="field"><span>{t("fields.email")}</span><input name="email" type="email" autoComplete="off" defaultValue={initialInput?.email??""}/></label>
   <label className="field"><span>{t("fields.phone")}</span><input name="phone" type="tel" autoComplete="off" defaultValue={initialInput?.phone??""}/></label>
   <label className="field"><span>{t("fields.preferredLocale")}</span><select name="preferredLocale" defaultValue={initialInput?.preferredLocale??locale}>{(["en","fr","ar"]as const).map(value=><option key={value} value={value}>{t("languages."+value)}</option>)}</select></label>
   <label className="field"><span>{t("fields.notes")}</span><textarea name="notes" rows={3} autoComplete="off" defaultValue={initialInput?.notes??""}/></label>
  </>:<section className="resource-form" data-testid="onboarding-owner-choices"><label className="field"><span>{t("searchOwner")}</span><input name="ownerQuery" value={query} autoComplete="off" onChange={event=>setQuery(event.target.value)}/></label><button type="button" className="secondary-button" onClick={()=>onSearch(query)}>{t("search")}</button>
   {selectedOwner&&<section className="resource-form" data-testid="onboarding-selected-owner"><h3>{t("selectedOwner")}</h3><p dir="auto">{selectedOwner.displayName}</p>{selectedOwner.email&&<p dir="ltr">{selectedOwner.email}</p>}</section>}
   {choices&&<><ul className="onboarding-list">{choices.owners.map(owner=><li key={owner.id}><button type="button" className="quiet-button" data-testid="onboarding-owner-choice" onClick={()=>onChoose(owner)}><span dir="auto">{owner.displayName}</span>{owner.email&&<span dir="ltr">{owner.email}</span>}</button></li>)}</ul>{!choices.owners.length&&<p>{t("noOwners")}</p>}{choices.next&&<button type="button" className="secondary-button" onClick={()=>onSearch(query,true)}>{t("more")}</button>}</>}
  </section>}
  <label className="field"><span>{t("reason")}</span><textarea name="reason" required autoComplete="off" rows={3} defaultValue={initialReason??""}/></label>
  <div className="form-actions"><button className="primary-button" type="submit" disabled={!options.modes.includes(mode)||mode==="LINK"&&!selectedOwner}>{t("review")}</button><button className="secondary-button" type="button" onClick={onCancel}>{t("cancel")}</button></div>
 </fieldset></form>;
}
