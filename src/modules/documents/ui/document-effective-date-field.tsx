"use client";
import {useId} from "react";
import {useTranslations} from "next-intl";

export function DocumentEffectiveDateField({value,onChange,disabled,testId}:{value:string;onChange:(value:string)=>void;disabled:boolean;testId:string}){
  const t=useTranslations("DocumentEffectiveDates"),hint=useId();
  return <><label className="field"><span>{t("effectiveFromUtc")}</span><input type="datetime-local" step={60} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)} aria-describedby={hint} dir="ltr" data-testid={testId}/></label><p id={hint}>{t("effectiveGuidance")}</p></>;
}
