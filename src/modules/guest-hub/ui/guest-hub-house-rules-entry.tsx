"use client";
import {useState} from "react";
import dynamic from "next/dynamic";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";
const HouseRulesForm=dynamic(()=>import("./guest-hub-house-rules-form").then(module=>module.GuestHubHouseRulesForm),{loading:()=> <SkeletonBlock rows={2}/>});
export function GuestHubHouseRulesEntry({locale,linkId}:{locale:AppLocale;linkId:string}){const t=useTranslations("GuestHouseRules"),[open,setOpen]=useState(false);return open?<HouseRulesForm key={linkId} locale={locale} linkId={linkId} onClose={()=>setOpen(false)}/>:<section className="resource-form" data-testid="guest-house-rules-entry"><h3>{t("title")}</h3><p>{t("guidance")}</p><button type="button" className="secondary-button" onClick={()=>setOpen(true)} data-testid="guest-house-rules-open">{t("open")}</button></section>;}
