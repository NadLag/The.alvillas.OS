"use client";
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import type { documentItemSchema,documentVersionItemSchema,documentSourceWorkspaceSchema } from "../domain/document-read-model";
import type { documentUploadReviewInput } from "../domain/document-command";
import {documentEffectiveFromUtc} from "../domain/document-effective-version";
import {DocumentEffectiveDateField} from "./document-effective-date-field";

type Document=z.infer<typeof documentItemSchema>;
type Version=z.infer<typeof documentVersionItemSchema>;
type TypeChoice=z.infer<typeof documentSourceWorkspaceSchema>["types"][number];
export type DocumentFileDraft=Pick<z.infer<typeof documentUploadReviewInput>,"title"|"typeKey"|"locale"|"kind"|"templateKey"|"effectiveFrom">&{reason:string};
export function DocumentFileEditor({locale,types,kind,amendment,disabled,onSubmit}:{locale:AppLocale;types:TypeChoice[];kind:"FILE"|"TEMPLATE";amendment:{document:Document;version:Version}|null;disabled:boolean;onSubmit:(draft:DocumentFileDraft,file:File)=>void}){
  const t=useTranslations("DocumentArchive"),[typeKey,setTypeKey]=useState(""),[title,setTitle]=useState(""),[reason,setReason]=useState(""),[effectiveUtc,setEffectiveUtc]=useState(""),[templateKey,setTemplateKey]=useState(""),[language,setLanguage]=useState<AppLocale>(locale),[file,setFile]=useState<File|null>(null),[invalid,setInvalid]=useState(false);
  const selectedKey=amendment?.document.typeKey??(typeKey||types[0]?.key),selected=types.find(type=>type.key===selectedKey),activeKind=amendment?.document.kind??kind;
  const submit=(event:FormEvent)=>{event.preventDefault();if(!selected||!file||file.size<1||file.size>selected.maxBytes||!selected.contentTypes.some(type=>type===file.type)||!title.trim()||reason.trim().length<8||activeKind==="INSTANCE"){setInvalid(true);return;}
    let effectiveFrom:string|null;try{effectiveFrom=documentEffectiveFromUtc(effectiveUtc);}catch{setInvalid(true);return;}
    setInvalid(false);onSubmit({title:title.trim(),reason:reason.trim(),typeKey:selected.key,locale:amendment?.document.locale??language,kind:activeKind,templateKey:activeKind==="TEMPLATE"?amendment?.document.templateKey??templateKey:null,effectiveFrom},file);
  };
  if(!types.length)return <p>{t("readOnly")}</p>;
  return <form className="resource-form" onSubmit={submit} data-testid="document-file-editor"><h2>{t(amendment?"addVersion":"newDocument")}</h2>
    {amendment?<p dir="auto">{t("amends",{title:amendment.document.title,version:amendment.version.number})}</p>:null}
    <label className="field"><span>{t("documentType")}</span><select value={selected?.key??""} disabled={disabled||Boolean(amendment)} onChange={event=>{setTypeKey(event.target.value);setFile(null);}} data-testid="document-type">
      {types.map(type=><option key={type.key} value={type.key}>{type.labels[locale]}</option>)}</select></label>
    <label className="field"><span>{t("documentTitle")}</span><input required maxLength={500} value={title} disabled={disabled} onChange={event=>setTitle(event.target.value)} dir="auto" data-testid="document-title-input"/></label>
    <label className="field"><span>{t("language")}</span><select value={amendment?.document.locale??language} disabled={disabled||Boolean(amendment)} onChange={event=>setLanguage(event.target.value as AppLocale)} data-testid="document-locale">
      {(["en","fr","ar"] as const).map(value=><option key={value} value={value}>{t(`language_${value}`)}</option>)}</select></label>
    {activeKind==="TEMPLATE"?<label className="field"><span>{t("templateCode")}</span><input required pattern="[a-z][a-z0-9_]{0,119}" maxLength={120} value={amendment?.document.templateKey??templateKey} disabled={disabled||Boolean(amendment)} onChange={event=>setTemplateKey(event.target.value)} dir="ltr" data-testid="document-template-code"/></label>:null}
    <label className="field"><span>{t("originalFile")}</span><input key={selected?.key} type="file" required accept={selected?.contentTypes.join(",")} disabled={disabled} onChange={event=>{if(selected)setTypeKey(selected.key);setFile(event.target.files?.[0]??null);}} data-testid="document-file"/></label>
    <p>{t("fileLimit",{bytes:selected?.maxBytes??0})}</p>
    <DocumentEffectiveDateField value={effectiveUtc} onChange={setEffectiveUtc} disabled={disabled} testId="document-effective-from"/>
    <label className="field"><span>{t("reason")}</span><textarea required minLength={8} maxLength={1000} value={reason} disabled={disabled} onChange={event=>setReason(event.target.value)} dir="auto" data-testid="document-reason"/></label>
    {invalid?<p role="alert">{t("validation")}</p>:null}<div className="form-actions"><button className="primary-button" disabled={disabled} data-testid="document-save">{t("saveOriginal")}</button></div>
  </form>;
}
