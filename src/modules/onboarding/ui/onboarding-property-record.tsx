"use client";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {onboardingPropertyReviewSchema} from "../domain/onboarding-property";

type Review=z.infer<typeof onboardingPropertyReviewSchema>;
export function OnboardingPropertyRecord({review,reason}:{review:Pick<Review,"owner"|"property">&Partial<Pick<Review,"draft">>;reason:string}){
 const t=useTranslations("OnboardingWizard"),value=review.property??(review.draft?.target.mode==="CREATE"?review.draft.target.input:null);
 if(!value)return null;
 const textFields=["name","addressLine1","addressLine2","city","region","countryCode","propertyType","timezone"]as const,numberFields=["bedrooms","bathrooms","livingSpaces","parkingSpaces","maxGuests"]as const;
 return <div className="resource-form" data-testid="onboarding-property-values"><dl className="onboarding-values"><div><dt>{t("selectedOwner")}</dt><dd dir="auto">{review.owner.displayName}</dd></div>{textFields.map(key=><div key={key}><dt>{t("property.fields."+key)}</dt><dd dir={["countryCode","timezone"].includes(key)?"ltr":"auto"}>{value[key]??t("property.noValue")}</dd></div>)}{numberFields.map(key=><div key={key}><dt>{t("property.fields."+key)}</dt><dd>{value[key]}</dd></div>)}{(["hasPool","hasGarden"]as const).map(key=><div key={key}><dt>{t("property.fields."+key)}</dt><dd>{t(value[key]?"property.yes":"property.no")}</dd></div>)}<div><dt>{t("property.fields.amenities")}</dt><dd>{value.amenities.length?<ul className="onboarding-list">{value.amenities.map((item,index)=><li key={index} dir="auto">{item}</li>)}</ul>:t("property.noValue")}</dd></div><div><dt>{t("property.fields.photoUrls")}</dt><dd>{value.photoUrls.length?<ul className="onboarding-list">{value.photoUrls.map((url,index)=><li key={index} className="onboarding-private-text" dir="ltr">{url}</li>)}</ul>:t("property.noValue")}</dd></div><div><dt>{t("reason")}</dt><dd className="onboarding-private-text" dir="auto">{reason}</dd></div></dl></div>;
}
