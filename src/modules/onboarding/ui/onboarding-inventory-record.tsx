"use client";
import {useLocale,useTranslations} from "next-intl";
import type {z} from "zod";
import {localizedText} from "@/i18n/content";
import {formatNumber} from "@/i18n/format";
import {safeLocale} from "@/i18n/routing";
import type {OnboardingInventorySnapshot,onboardingInventoryReviewSchema} from "../domain/onboarding-inventory";
import {OnboardingPropertyRecord} from "./onboarding-property-record";

type Settings=NonNullable<OnboardingInventorySnapshot["settings"]>;
type Review=z.infer<typeof onboardingInventoryReviewSchema>;
export function InventorySettings({settings}:{settings:Settings|null}){
 const t=useTranslations("OnboardingWizard"),locale=safeLocale(useLocale());
 if(!settings)return <p>{t("inventory.noConfiguration")}</p>;
 if(!settings.minimums.length)return <p>{t("inventory.noItems")}</p>;
 return <ul className="onboarding-list">{settings.minimums.map(row=><li key={row.item}><h4 dir="auto">{row.name?localizedText(row.name,locale):row.item}</h4><dl className="onboarding-values">
  <div><dt>{t("inventory.fields.item")}</dt><dd dir="ltr">{row.item}</dd></div><div><dt>{t("inventory.fields.quantity")}</dt><dd dir="ltr">{formatNumber(locale,String(row.quantity))}</dd></div><div><dt>{t("inventory.fields.unit")}</dt><dd dir="auto">{row.unit??t("property.noValue")}</dd></div><div><dt>{t("inventory.fields.category")}</dt><dd>{row.category?t("inventory.categories."+row.category):t("property.noValue")}</dd></div><div><dt>{t("inventory.fields.perStay")}</dt><dd>{row.expected_per_stay===null?t("inventory.perStay.UNSPECIFIED"):formatNumber(locale,String(row.expected_per_stay))}</dd></div>
 </dl></li>)}</ul>;
}
export function OnboardingInventoryRecord({review,reason}:{review:Pick<Review,"draft"|"owner"|"property"|"previousInventory">&Partial<Pick<Review,"proposedInventory"|"selectedTemplate">>&{inventory?:OnboardingInventorySnapshot};reason:string}){
 const t=useTranslations("OnboardingWizard"),locale=safeLocale(useLocale()),template=review.inventory?.template??review.selectedTemplate??(review.draft.target.mode==="CUSTOM"?review.previousInventory.template:null),settings=review.inventory?.settings??review.proposedInventory??null;
 return <section className="resource-form" data-testid="onboarding-inventory-record"><OnboardingPropertyRecord review={{owner:review.owner,property:review.property}} reason={reason}/><p>{t("inventory.modes."+review.draft.target.mode)}</p><section className="resource-form"><h3>{t("inventory.previous")}</h3><InventorySettings settings={review.previousInventory.settings}/></section><section className="resource-form"><h3>{t(review.inventory?"inventory.original":"inventory.proposed")}</h3><InventorySettings settings={settings}/><dl className="onboarding-values"><div><dt>{t("inventory.template")}</dt><dd dir="auto">{template?localizedText(template.name,locale):t("inventory.noTemplate")}</dd></div></dl>{review.inventory?.templateRevision&&<p>{t("inventory.templateRevision",{revision:review.inventory.templateRevision})}</p>}</section></section>;
}
