"use client";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import type {leadFieldsSchema} from "../domain/lead-capture";
import type {leadWorkspaceOptionsSchema} from "../domain/lead-workspace";
export function LeadRecordFields({fields,options,locale}:{fields:z.infer<typeof leadFieldsSchema>|undefined;options:z.infer<typeof leadWorkspaceOptionsSchema>;locale:AppLocale}){
  const t=useTranslations("LeadWorkspace");if(!fields)return <p>{t("restricted")}</p>;
  const choice=(value:string|undefined,choices:typeof options.propertyTypes)=>value?localizedText(choices.find(c=>c.key===value)?.label??{en:value,fr:value},locale):t("notProvided");
  const values={ownerContact:fields.ownerContact,phone:fields.phone,email:fields.email,location:fields.location,propertyTypeKey:choice(fields.propertyTypeKey,options.propertyTypes),bedrooms:fields.bedrooms?.toLocaleString(locale),currentRentalStatusKey:choice(fields.currentRentalStatusKey,options.rentalStatuses),currentOtaKeys:fields.currentOtaKeys?.length?new Intl.ListFormat(locale).format(fields.currentOtaKeys.map(key=>choice(key,options.otas))):undefined,objectives:fields.objectives,notes:fields.notes};
  return <><dl className="lead-values">{Object.entries(values).map(([key,value])=><div key={key}><dt>{t("fields."+key)}</dt><dd dir={key==="phone"||key==="email"?"ltr":"auto"}>{value??t("notProvided")}</dd></div>)}</dl>{fields.referralContact&&<section><h3>{t("fields.referralContact")}</h3><dl className="lead-values">{(["name","phone","email"]as const).map(key=><div key={key}><dt>{t("referral."+key)}</dt><dd dir={key==="name"?"auto":"ltr"}>{fields.referralContact?.[key]??t("notProvided")}</dd></div>)}</dl></section>}</>;
}
