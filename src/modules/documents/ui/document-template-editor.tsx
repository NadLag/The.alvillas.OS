"use client";
import { useState,type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { documentTemplateDefinitionSchema,encodeDocumentTemplate,templateVariableKinds,type DocumentTemplateDefinition } from "../domain/document-template";
import type { documentSourceWorkspaceSchema } from "../domain/document-read-model";

type TypeChoice=z.infer<typeof documentSourceWorkspaceSchema>["types"][number];
type Block=DocumentTemplateDefinition["blocks"][number]&{editorId:string};
type Variable=DocumentTemplateDefinition["variables"][number]&{editorId:string};
export type AuthoredTemplateDraft={typeKey:string;title:string;reason:string;definition:DocumentTemplateDefinition};
export function DocumentTemplateEditor({locale,types,identity,definition,disabled,onSubmit}:{locale:AppLocale;types:TypeChoice[];identity:{templateKey:string;locale:AppLocale;typeKey:string;title:string}|null;definition:DocumentTemplateDefinition|null;disabled:boolean;onSubmit:(value:AuthoredTemplateDraft)=>void}){
  const t=useTranslations("DocumentTemplates"),archive=useTranslations("DocumentArchive"),[typeKey,setTypeKey]=useState(""),[title,setTitle]=useState(identity?.title??""),[reason,setReason]=useState(""),
    [templateKey,setTemplateKey]=useState(definition?.templateKey??""),[language,setLanguage]=useState<AppLocale>(definition?.locale??locale),[heading,setHeading]=useState(definition?.title??""),
    [variables,setVariables]=useState<Variable[]>(()=>definition?.variables.map((item,index)=>({...item,editorId:"variable_"+index}))??[]),
    [blocks,setBlocks]=useState<Block[]>(()=>definition?.blocks.map((item,index)=>({...item,editorId:"block_"+index}))??[{editorId:"block_0",kind:"PARAGRAPH",text:""}]),[invalid,setInvalid]=useState(false);
  const selected=types.find(type=>type.key===(identity?.typeKey??(typeKey||types[0]?.key)));
  const submit=(event:FormEvent)=>{
    event.preventDefault();const parsed=documentTemplateDefinitionSchema.safeParse({schemaVersion:1,templateKey:identity?.templateKey??templateKey,locale:identity?.locale??language,title:heading,
      variables:variables.map(({key,kind})=>({key,kind})),blocks:blocks.map(({kind,text})=>({kind,text}))});
    if(!parsed.success||!selected||!title.trim()||reason.trim().length<8||encodeDocumentTemplate(parsed.data).length>selected.maxBytes){setInvalid(true);return;}
    setInvalid(false);onSubmit({typeKey:selected.key,title:title.trim(),reason:reason.trim(),definition:parsed.data});
  };
  return <form className="resource-form" data-testid="document-template-editor" onSubmit={submit}><h2>{t(identity?"editTitle":"newTitle")}</h2>
    <label className="field"><span>{archive("documentType")}</span><select value={selected?.key??""} disabled={disabled||Boolean(identity)} onChange={event=>setTypeKey(event.target.value)} data-testid="template-type">{types.map(type=><option key={type.key} value={type.key}>{type.labels[locale]}</option>)}</select></label>
    <label className="field"><span>{t("archiveLabel")}</span><input required maxLength={500} value={title} disabled={disabled} onChange={event=>setTitle(event.target.value)} dir="auto" data-testid="template-archive-title"/></label>
    <label className="field"><span>{archive("templateCode")}</span><input required pattern="[a-z][a-z0-9_]{0,119}" maxLength={120} value={identity?.templateKey??templateKey} disabled={disabled||Boolean(identity)} onChange={event=>setTemplateKey(event.target.value)} dir="ltr" data-testid="template-code"/></label>
    <p>{t("codeGuidance")}</p><label className="field"><span>{archive("language")}</span><select value={identity?.locale??language} disabled={disabled||Boolean(identity)} onChange={event=>setLanguage(event.target.value as AppLocale)} data-testid="template-locale">{(["en","fr","ar"] as const).map(value=><option key={value} value={value}>{archive(`language_${value}`)}</option>)}</select></label>
    <label className="field"><span>{t("heading")}</span><input required maxLength={500} value={heading} disabled={disabled} onChange={event=>setHeading(event.target.value)} dir="auto" data-testid="template-heading"/></label>
    <section className="resource-form"><h3>{t("variables")}</h3><p>{t("syntax",{example:"{{"+t("exampleKey")+"}}"})}</p>
      {variables.map((variable,index)=><fieldset className="document-template-section" key={variable.editorId} data-testid="template-variable"><legend>{t("variableNumber",{number:index+1})}</legend>
        <label className="field"><span>{t("variableKey")}</span><input required pattern="[a-z][a-z0-9_]{0,79}" maxLength={80} value={variable.key} disabled={disabled} onChange={event=>setVariables(items=>items.map(item=>item.editorId===variable.editorId?{...item,key:event.target.value}:item))} dir="ltr" data-testid="template-variable-key"/></label>
        <label className="field"><span>{t("variableType")}</span><select value={variable.kind} disabled={disabled} onChange={event=>setVariables(items=>items.map(item=>item.editorId===variable.editorId?{...item,kind:event.target.value as Variable["kind"]}:item))} data-testid="template-variable-type">{templateVariableKinds.map(value=><option key={value} value={value}>{t(`value_${value}`)}</option>)}</select></label>
        <button type="button" className="quiet-button" disabled={disabled} onClick={()=>setVariables(items=>items.filter(item=>item.editorId!==variable.editorId))}>{t("removeVariable")}</button></fieldset>)}
      <button type="button" className="secondary-button" disabled={disabled||variables.length>=200} onClick={()=>setVariables(items=>[...items,{editorId:crypto.randomUUID(),key:"",kind:"TEXT"}])} data-testid="template-add-variable">{t("addVariable")}</button>
    </section><section className="resource-form"><h3>{t("sections")}</h3>
      {blocks.map((block,index)=><fieldset className="document-template-section" key={block.editorId} data-testid="template-section"><legend>{t("sectionNumber",{number:index+1})}</legend>
        <label className="field"><span>{t("sectionType")}</span><select value={block.kind} disabled={disabled} onChange={event=>setBlocks(items=>items.map(item=>item.editorId===block.editorId?{...item,kind:event.target.value as Block["kind"]}:item))} data-testid="template-section-kind">{(["HEADING","PARAGRAPH","BULLET"] as const).map(value=><option key={value} value={value}>{t(`block_${value}`)}</option>)}</select></label>
        <label className="field"><span>{t("sectionText")}</span><textarea required maxLength={20000} rows={5} value={block.text} disabled={disabled} onChange={event=>setBlocks(items=>items.map(item=>item.editorId===block.editorId?{...item,text:event.target.value}:item))} dir="auto" data-testid="template-section-text"/></label>
        <button type="button" className="quiet-button" disabled={disabled||blocks.length===1} onClick={()=>setBlocks(items=>items.filter(item=>item.editorId!==block.editorId))}>{t("removeSection")}</button></fieldset>)}
      <button type="button" className="secondary-button" disabled={disabled||blocks.length>=200} onClick={()=>setBlocks(items=>[...items,{editorId:crypto.randomUUID(),kind:"PARAGRAPH",text:""}])} data-testid="template-add-section">{t("addSection")}</button>
    </section><label className="field"><span>{archive("reason")}</span><textarea required minLength={8} maxLength={1000} value={reason} disabled={disabled} onChange={event=>setReason(event.target.value)} dir="auto" data-testid="template-reason"/></label>
    {invalid?<p role="alert">{t("validation")}</p>:null}<div className="form-actions"><button type="submit" className="primary-button" disabled={disabled||!selected} data-testid="template-save">{t("save")}</button></div>
  </form>;
}
