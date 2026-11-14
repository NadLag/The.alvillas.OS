"use client";
import {useState} from "react";
import dynamic from "next/dynamic";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";
const StayDetailsForm=dynamic(()=>import("./guest-hub-stay-details-form").then(module=>module.GuestHubStayDetailsForm),{loading:()=> <SkeletonBlock rows={2}/>});
export function GuestHubStayDetailsEntry({locale,linkId}:{locale:AppLocale;linkId:string}){const t=useTranslations("GuestStayDetails"),[open,setOpen]=useState(false);return open?<StayDetailsForm key={linkId} locale={locale} linkId={linkId} onClose={()=>setOpen(false)}/>:<section className="resource-form" data-testid="guest-stay-details-entry"><h3>{t("title")}</h3><p>{t("guidance")}</p><button type="button" className="secondary-button" onClick={()=>setOpen(true)} data-testid="guest-stay-details-open">{t("open")}</button></section>;}
