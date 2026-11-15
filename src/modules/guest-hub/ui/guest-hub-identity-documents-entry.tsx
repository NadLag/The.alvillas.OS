"use client";
import {useState} from "react";
import dynamic from "next/dynamic";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";

const IdentityForm=dynamic(()=>import("./guest-hub-identity-documents-form").then(module=>module.GuestHubIdentityDocumentsForm),{loading:()=> <SkeletonBlock rows={2}/>});
export function GuestHubIdentityDocumentsEntry({locale,linkId}:{locale:AppLocale;linkId:string}){
 const t=useTranslations("GuestIdentityDocuments"),[open,setOpen]=useState(false);
 return open?<IdentityForm key={locale+":"+linkId} locale={locale} linkId={linkId} onClose={()=>setOpen(false)}/>:<section className="resource-form" data-testid="guest-identity-entry"><h3>{t("title")}</h3><p>{t("guidance")}</p><button type="button" className="secondary-button" onClick={()=>setOpen(true)} data-testid="guest-identity-open">{t("open")}</button></section>;
}
