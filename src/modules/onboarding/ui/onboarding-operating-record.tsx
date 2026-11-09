"use client";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {onboardingOperatingReviewSchema,OnboardingOperatingProfile} from "../domain/onboarding-operating-profile";
import {OnboardingPropertyRecord} from "./onboarding-property-record";

export const operatingBooleanFields=[["cleaningEnabled","cleaning"],["inspectionEnabled","inspection"],["poolServiceEnabled","poolService"],["gardenServiceEnabled","gardenService"],["laundryManaged","laundry"],["linenManaged","linen"],["maintenanceTrackingEnabled","maintenance"],["midStayCleaningEnabled","midStayCleaning"],["breakfastAvailable","breakfast"],["chefAvailable","chef"],["transfersAvailable","transfers"],["groceriesAvailable","groceries"],["wellnessAvailable","wellness"]]as const;
export const operatingCadenceFields=[["cleaningFrequency","cleaning"],["inspectionFrequency","inspection"],["poolServiceFrequency","poolService"],["gardenServiceFrequency","gardenService"],["preventiveMaintenanceFrequency","preventiveMaintenance"]]as const;
export function OnboardingOperatingValues({profile}:{profile:OnboardingOperatingProfile|null}){
 const c=useTranslations("Core.properties.operating"),common=useTranslations("Core.common"),t=useTranslations("OnboardingWizard");
 if(!profile)return <p>{c("empty")}</p>;
 return <dl className="onboarding-values" data-testid="onboarding-operating-values">
  {operatingBooleanFields.map(([field,label])=><div key={field}><dt>{c(label)}</dt><dd>{common(profile[field]?"yes":"no")}</dd></div>)}
  {operatingCadenceFields.map(([field,label])=><div key={field}><dt>{c(label)} · {c("cadence")}</dt><dd>{c("cadenceOptions."+profile[field])}</dd></div>)}
  <div><dt>{c("midStayRuleKey")}</dt><dd dir="ltr">{profile.midStayCleaningRuleKey??t("property.noValue")}</dd></div>
  <div><dt>{c("otherServices")}</dt><dd>{profile.otherServices.length?<ul className="onboarding-list">{profile.otherServices.map((item,index)=><li key={index} dir="auto">{item}</li>)}</ul>:t("property.noValue")}</dd></div>
  <div><dt>{c("automationNotes")}</dt><dd className="onboarding-private-text" dir="auto">{profile.automationNotes??t("property.noValue")}</dd></div>
 </dl>;
}
type Review=Pick<z.infer<typeof onboardingOperatingReviewSchema>,"owner"|"property"|"previousOperatingProfile"|"operatingProfile"|"operatingRule">;
export function OnboardingOperatingRecord({review,reason}:{review:Review;reason:string}){
 const t=useTranslations("OnboardingWizard"),rule=review.operatingRule;
 return <div className="resource-form" data-testid="onboarding-operating-record">
  <OnboardingPropertyRecord review={{owner:review.owner,property:review.property}} reason={reason}/>
  <section className="resource-form" data-testid="onboarding-operating-before"><h3>{t("operating.before")}</h3><OnboardingOperatingValues profile={review.previousOperatingProfile}/></section>
  <section className="resource-form" data-testid="onboarding-operating-after"><h3>{t("operating.after")}</h3><OnboardingOperatingValues profile={review.operatingProfile}/></section>
  {rule&&<dl className="onboarding-values" data-testid="onboarding-operating-rule"><div><dt>{t("operating.ruleVersion")}</dt><dd>{rule.version}</dd></div><div><dt>{t("operating.ruleNights")}</dt><dd>{rule.nights}</dd></div>{rule.taskTemplateKey&&<div><dt>{t("operating.ruleTemplate")}</dt><dd dir="auto">{rule.taskTemplateKey}</dd></div>}</dl>}
 </div>;
}
