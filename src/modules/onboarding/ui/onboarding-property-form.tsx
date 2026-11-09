"use client";
import {useState,type FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import {onboardingPhysicalPropertyDefaults} from "@/platform/onboarding/contracts";
import {canonicalOnboardingPropertyDraft,type OnboardingPropertyDraft,type onboardingPropertyChoicesSchema} from "../domain/onboarding-property";
import {onboardingMaximumRequestBytes} from "../domain/onboarding-wizard";

export type OnboardingPropertyChoice=z.infer<typeof onboardingPropertyChoicesSchema>["properties"][number];
type CreateInput=Extract<OnboardingPropertyDraft["target"],{mode:"CREATE"}>["input"];
type Props={sessionId:string;previousRevisionId:string;ownerId:string;ownerName:string;modes:("CREATE"|"LINK")[];disabled:boolean;selected:OnboardingPropertyChoice|null;choices:z.infer<typeof onboardingPropertyChoicesSchema>|null;initialInput?:CreateInput;initialReason?:string;onSearch:(query:string,append?:boolean)=>void;onChoose:(property:OnboardingPropertyChoice)=>void;onClear:()=>void;onReview:(draft:OnboardingPropertyDraft,reason:string)=>void;onCancel:()=>void};
const textFields=["name","addressLine1","addressLine2","city","region","countryCode","propertyType","timezone"]as const;
const numberFields=["bedrooms","bathrooms","livingSpaces","parkingSpaces","maxGuests"]as const;
export function OnboardingPropertyForm({sessionId,previousRevisionId,ownerId,ownerName,modes,disabled,selected,choices,initialInput,initialReason,onSearch,onChoose,onClear,onReview,onCancel}:Props){
 const t=useTranslations("OnboardingWizard"),[mode,setMode]=useState<"CREATE"|"LINK">(selected&&modes.includes("LINK")?"LINK":modes[0]??"CREATE"),[query,setQuery]=useState(""),[invalid,setInvalid]=useState(false);
 const defaults={...onboardingPhysicalPropertyDefaults,...initialInput};
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setInvalid(false);try{
  const fields=new FormData(event.currentTarget),text=(key:string)=>{const value=fields.get(key);return typeof value==="string"?value:"";},reason=text("reason").trim();if(!reason||reason.length>1000)throw Error("reason_required");
  const lines=(key:string)=>text(key).split(/\r?\n/u).map(value=>value.trim()).filter(Boolean),target=mode==="LINK"?{mode,propertyId:selected?.id}:{mode,input:{ownerId,...Object.fromEntries([...textFields,...numberFields].map(key=>[key,text(key)])),hasPool:fields.get("hasPool")==="on",hasGarden:fields.get("hasGarden")==="on",amenities:lines("amenities"),photoUrls:lines("photoUrls"),status:"DRAFT"}},draft=canonicalOnboardingPropertyDraft({sessionId,previousRevisionId,step:"PROPERTY",target});
  if(new TextEncoder().encode(JSON.stringify({...draft,idempotencyKey:crypto.randomUUID(),reviewFingerprint:"0".repeat(64),reason})).byteLength>onboardingMaximumRequestBytes)throw Error("request_size");onReview(draft,reason);
 }catch{setInvalid(true);}};
 return <form className="resource-form" data-testid="onboarding-property-form" onSubmit={submit}><fieldset className="resource-form" disabled={disabled}><legend>{t("steps.PROPERTY")}</legend>
  <p>{t("property.guidance")}</p><div><strong>{t("selectedOwner")}</strong><p dir="auto">{ownerName}</p></div>{invalid&&<p className="form-error" role="alert">{t("property.states.validation")}</p>}
  <label className="field"><span>{t("property.mode")}</span><select name="mode" value={mode} onChange={event=>{setMode(event.target.value as "CREATE"|"LINK");setQuery("");setInvalid(false);onClear();}}>{modes.map(value=><option key={value} value={value}>{t("property.modes."+value)}</option>)}</select></label>
  {mode==="CREATE"?<>
   {textFields.map(key=><label key={key} className="field"><span>{t("property.fields."+key)}</span><input name={key} required={!["addressLine2","region"].includes(key)} autoComplete="off" defaultValue={defaults[key]??""} maxLength={key==="countryCode"?2:undefined} dir={["countryCode","timezone"].includes(key)?"ltr":"auto"}/></label>)}
   {numberFields.map(key=><label key={key} className="field"><span>{t("property.fields."+key)}</span><input name={key} type="number" required min={key==="maxGuests"?1:0} step={1} defaultValue={defaults[key]??""} autoComplete="off"/></label>)}
   {(["hasPool","hasGarden"]as const).map(key=><label key={key} className="checkbox-field"><input name={key} type="checkbox" defaultChecked={defaults[key]}/><span>{t("property.fields."+key)}</span></label>)}
   <label className="field"><span>{t("property.fields.amenities")}</span><textarea name="amenities" rows={4} autoComplete="off" defaultValue={initialInput?.amenities.join("\n")??""}/><span className="field-help">{t("property.amenitiesHint")}</span></label>
   <label className="field"><span>{t("property.fields.photoUrls")}</span><textarea name="photoUrls" rows={4} autoComplete="off" dir="ltr" defaultValue={initialInput?.photoUrls.join("\n")??""}/><span className="field-help">{t("property.photosHint")}</span></label>
  </>:<section className="resource-form" data-testid="onboarding-property-choices"><label className="field"><span>{t("property.searchLabel")}</span><input name="propertyQuery" value={query} autoComplete="off" onChange={event=>setQuery(event.target.value)}/></label><button type="button" className="secondary-button" onClick={()=>onSearch(query)}>{t("property.search")}</button>
   {selected&&<section className="resource-form" data-testid="onboarding-selected-property"><h3>{t("property.selected")}</h3><p dir="auto">{selected.name}</p><p dir="auto">{selected.addressLine1}</p><p dir="auto">{selected.city}</p></section>}
   {choices&&<><ul className="onboarding-list">{choices.properties.map(property=><li key={property.id}><button type="button" className="quiet-button" data-testid="onboarding-property-choice" onClick={()=>onChoose(property)}><span dir="auto">{property.name}</span><span dir="auto">{property.addressLine1}</span><span dir="auto">{property.city}</span></button></li>)}</ul>{!choices.properties.length&&<p>{t("property.empty")}</p>}{choices.next&&<button type="button" className="secondary-button" onClick={()=>onSearch(query,true)}>{t("more")}</button>}</>}
  </section>}
  <label className="field"><span>{t("reason")}</span><textarea name="reason" required autoComplete="off" rows={3} maxLength={1000} defaultValue={initialReason??""}/></label><div className="form-actions"><button type="submit" className="primary-button" disabled={!modes.includes(mode)||mode==="LINK"&&!selected}>{t("property.review")}</button><button type="button" className="secondary-button" onClick={onCancel}>{t("cancel")}</button></div>
 </fieldset></form>;
}
