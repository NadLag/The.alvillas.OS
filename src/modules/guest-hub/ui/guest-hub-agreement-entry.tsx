"use client";
import {useState} from "react";
import dynamic from "next/dynamic";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";
const AgreementForm=dynamic(()=>import("./guest-hub-agreement-form").then(module=>module.GuestHubAgreementForm),{loading:()=> <SkeletonBlock rows={2}/>});
export function GuestHubAgreementEntry({locale,linkId}:{locale:AppLocale;linkId:string}){const t=useTranslations("GuestAgreement"),[open,setOpen]=useState(false);return open?<AgreementForm key={linkId+":"+locale} locale={locale} linkId={linkId} onClose={()=>setOpen(false)}/>:<section className="resource-form" data-testid="guest-agreement-entry"><h3>{t("title")}</h3><p>{t("guidance")}</p><button type="button" className="secondary-button" onClick={()=>setOpen(true)} data-testid="guest-agreement-open">{t("open")}</button></section>;}
