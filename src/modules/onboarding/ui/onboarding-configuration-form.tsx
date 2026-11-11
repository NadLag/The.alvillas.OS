"use client";
import {useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {onboardingConfigurationOptionsSchema} from "../domain/onboarding-contract";
import {canonicalOnboardingConfigurationDraft,type OnboardingConfigurationDraft} from "../domain/onboarding-configuration-review";

export function OnboardingConfigurationForm({sessionId,options,disabled,initialReason,onReview,onCancel}:{sessionId:string;options:z.infer<typeof onboardingConfigurationOptionsSchema>;disabled:boolean;initialReason?:string;onReview:(draft:OnboardingConfigurationDraft,reason:string)=>void;onCancel:()=>void}){
 const t=useTranslations("OnboardingWizard"),[invalid,setInvalid]=useState(false);
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setInvalid(false);const value=new FormData(event.currentTarget).get("reason"),reason=typeof value==="string"?value.trim():"";if(!reason||reason.length>1000){setInvalid(true);return;}onReview(canonicalOnboardingConfigurationDraft({sessionId,previousRevisionId:options.revisionId,step:"REVIEW",target:{mode:"VALIDATE",propertyId:options.propertyId}}),reason);};
 return <form className="resource-form" onSubmit={submit} data-testid="onboarding-configuration-form"><h2>{t("configuration.title")}</h2><p>{t("configuration.guidance")}</p><label className="field"><span>{t("reason")}</span><textarea name="reason" required maxLength={1000} autoComplete="off" dir="auto" disabled={disabled} defaultValue={initialReason??""}/></label>{invalid&&<p role="alert">{t("configuration.reasonRequired")}</p>}<div className="form-actions"><button type="submit" className="primary-button" disabled={disabled} data-testid="onboarding-configuration-review">{t("configuration.review")}</button><button type="button" className="secondary-button" disabled={disabled} onClick={onCancel}>{t("cancel")}</button></div></form>;
}
