"use client";
import {useState} from "react";
import Image from "next/image";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import type {guestHubPublicViewSchema} from "../domain/guest-hub-contract";
import {GuestHubProfileEntry} from "./guest-hub-profile-entry";

type View=z.infer<typeof guestHubPublicViewSchema>;
function StayPhoto({src,property}:{src:string|null;property:string}){
 const t=useTranslations("GuestStay"),[failed,setFailed]=useState(false);
 return <div className="guest-stay-photo" data-testid="guest-stay-photo">{src&&!failed?<Image src={src} alt={t("photo",{property})} fill sizes="(max-width: 720px) 100vw, 640px" unoptimized loading="eager" fetchPriority="high" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<div className="guest-stay-photo-placeholder" role="img" aria-label={t("photoUnavailable",{property})}><span>{t("photoUnavailable",{property})}</span></div>}</div>;
}

/** Every visible fact belongs to the already verified original reservation. */
export function GuestHubStay({view,locale,onRefresh}:{view:View;locale:AppLocale;onRefresh:()=>void}){
 const t=useTranslations("GuestStay"),access=useTranslations("GuestAccess"),day=(value:string)=>new Intl.DateTimeFormat(locale,{dateStyle:"long",timeZone:"UTC"}).format(new Date(value+"T00:00:00Z")),home=view.home;
 const current=home.calendarStage==="UPCOMING"||home.calendarStage==="ARRIVAL_DAY"?"arrival":home.calendarStage==="STAY_DAYS"||home.calendarStage==="DEPARTURE_DAY"?"departure":null;
 return <section className="guest-stay" data-testid="guest-stay-home" aria-labelledby="guest-stay-title">
  <header><p className="guest-stay-stage" data-testid="guest-stay-stage">{t("calendarStage."+home.calendarStage)}</p><h2 id="guest-stay-title" dir="auto">{home.propertyName}</h2><p data-testid="guest-stay-guests">{t("adults",{count:home.adultCount})}{home.childCount>0?" · "+t("children",{count:home.childCount}):""}</p></header>
  <StayPhoto key={home.photoUrl??"unavailable"} src={home.photoUrl} property={home.propertyName}/>
  <section aria-labelledby="guest-stay-dates-title"><h3 id="guest-stay-dates-title">{t("dates")}</h3><ol className="guest-stay-itinerary" data-testid="guest-stay-itinerary">{(["arrival","departure"]as const).map(kind=><li key={kind} aria-current={current===kind?"step":undefined}><p>{access(kind)}</p><time dateTime={kind==="arrival"?view.checkIn:view.checkOut}>{day(kind==="arrival"?view.checkIn:view.checkOut)}</time></li>)}</ol><p className="guest-stay-timezone">{t("timezone",{timezone:view.timezone})}</p></section>
  <p>{access("accessUntil",{date:new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short",timeZone:view.timezone}).format(new Date(view.expiresAt))})}</p>
  <p className="guest-stay-checked" data-testid="guest-stay-checked">{t("checkedAt",{date:new Intl.DateTimeFormat(locale,{timeStyle:"short",timeZone:view.timezone}).format(new Date(home.checkedAt))})}</p>
  {home.profileAvailable&&<GuestHubProfileEntry key={view.id} locale={locale} linkId={view.id}/>}
  <div className="guest-stay-tools"><nav aria-label={access("language")}>{(["en","fr","ar"]as const).map(language=><a key={language} className="secondary-button" href={"/"+language+"/guest/"+view.id} hrefLang={language} lang={language} aria-current={locale===language?"page":undefined}>{access("languages."+language)}</a>)}</nav><button type="button" className="primary-button" onClick={onRefresh} data-testid="guest-access-refresh">{access("refresh")}</button></div>
 </section>;
}
