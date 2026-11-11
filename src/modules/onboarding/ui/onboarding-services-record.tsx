"use client";
import {useLocale,useTranslations} from "next-intl";
import type {z} from "zod";
import {localizedText} from "@/i18n/content";
import {formatCurrencyAmount} from "@/i18n/format";
import {safeLocale} from "@/i18n/routing";
import type {OnboardingServicesSnapshot,onboardingServicesReviewSchema} from "../domain/onboarding-services";
import {OnboardingPropertyRecord} from "./onboarding-property-record";

type Settings=NonNullable<OnboardingServicesSnapshot["settings"]>;
type Review=z.infer<typeof onboardingServicesReviewSchema>;
export function ServicesSettings({settings}:{settings:Settings|null}){
 const t=useTranslations("OnboardingWizard"),locale=safeLocale(useLocale());
 if(!settings)return <p>{t("services.noConfiguration")}</p>;
 if(!settings.services.length)return <p>{t("services.noItems")}</p>;
 return <ul className="onboarding-list">{settings.services.map(row=><li key={row.key}><h4 dir="auto">{row.name?localizedText(row.name,locale):row.key}</h4>{row.description&&<p dir="auto">{localizedText(row.description,locale)}</p>}<dl className="onboarding-values">
  <div><dt>{t("services.fields.key")}</dt><dd dir="ltr">{row.key}</dd></div><div><dt>{t("services.fields.available")}</dt><dd>{row.available===null?t("property.noValue"):t(row.available?"services.available":"services.unavailable")}</dd></div><div><dt>{t("services.fields.pricingModel")}</dt><dd>{t("services.pricingModels."+row.pricing_model)}</dd></div><div><dt>{t("services.fields.amount")}</dt><dd dir="auto">{row.amount===null?t(row.pricing_model==="CUSTOM"?"services.quoteRequired":"property.noValue"):row.currency?formatCurrencyAmount(locale,row.amount,row.currency):row.amount}</dd></div><div><dt>{t("services.fields.currency")}</dt><dd dir="ltr">{row.currency??t("property.noValue")}</dd></div>
 </dl></li>)}</ul>;
}
export function OnboardingServicesRecord({review,reason}:{review:Pick<Review,"draft"|"owner"|"property"|"previousServices">&Partial<Pick<Review,"proposedServices"|"selectedTemplate">>&{services?:OnboardingServicesSnapshot};reason:string}){
 const t=useTranslations("OnboardingWizard"),locale=safeLocale(useLocale()),template=review.services?.template??review.selectedTemplate??(review.draft.target.mode!=="TEMPLATE"?review.previousServices.template:null),settings=review.services?.settings??review.proposedServices??null;
 return <section className="resource-form" data-testid="onboarding-services-record"><OnboardingPropertyRecord review={{owner:review.owner,property:review.property}} reason={reason}/><p>{t("services.modes."+review.draft.target.mode)}</p><section className="resource-form"><h3>{t("services.previous")}</h3><ServicesSettings settings={review.previousServices.settings}/></section><section className="resource-form"><h3>{t(review.services?"services.original":"services.proposed")}</h3><ServicesSettings settings={settings}/><dl className="onboarding-values"><div><dt>{t("services.template")}</dt><dd dir="auto">{template?localizedText(template.name,locale):t("services.noTemplate")}</dd></div></dl>{review.services?.templateRevision&&<p>{t("services.templateRevision",{revision:review.services.templateRevision})}</p>}</section></section>;
}
