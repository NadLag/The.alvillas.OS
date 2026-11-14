"use client";
import {useState} from "react";
import dynamic from "next/dynamic";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import {SkeletonBlock} from "@/design-system/shells";

const ProfileForm=dynamic(()=>import("./guest-hub-profile-form").then(module=>module.GuestHubProfileForm),{loading:()=> <SkeletonBlock rows={2}/>});
export function GuestHubProfileEntry({locale,linkId}:{locale:AppLocale;linkId:string}){
 const t=useTranslations("GuestProfile"),[open,setOpen]=useState(false);return open?<ProfileForm key={linkId} locale={locale} linkId={linkId} onClose={()=>setOpen(false)}/>:<section className="resource-form" data-testid="guest-profile-entry"><h3>{t("title")}</h3><p>{t("guidance")}</p><button type="button" className="primary-button" onClick={()=>setOpen(true)} data-testid="guest-profile-open">{t("open")}</button></section>;
}
