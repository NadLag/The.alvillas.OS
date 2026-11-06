"use client";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import type { documentEffectiveHistorySchema,documentVersionItemSchema } from "../domain/document-read-model";

type Version=z.infer<typeof documentVersionItemSchema>;
export function DocumentHistoryPanel({locale,data,disabled,canAmend,onMore,onCurrent,onEffective,onDownload,onAmend,onSignature}:{locale:AppLocale;data:z.infer<typeof documentEffectiveHistorySchema>;disabled:boolean;canAmend:boolean;onMore:()=>void;onCurrent:()=>void;onEffective:()=>void;onDownload:(version:Version)=>void;onAmend:(version:Version)=>void;onSignature?:(version:Version)=>void}){
  const t=useTranslations("DocumentArchive"),effective=useTranslations("DocumentEffectiveDates"),signatures=useTranslations("DocumentSignatures");
  return <section className="resource-form" data-testid="document-history"><h2 dir="auto">{data.document.title}</h2><p>{t("historyGuidance")}</p>
    <p>{effective("observedAt",{at:formatDateTime(locale,new Date(data.observedAt),{timeZone:"UTC"})})}</p><p data-testid="document-effective-summary">{data.effectiveVersion?effective("effectiveSummary",{number:data.effectiveVersion.number}):effective("noEffectiveVersion")}</p>
    {!data.versions.length?<p>{t("noVersions")}</p>:<ul className="resource-list">{data.versions.map(version=><li key={version.id} className="resource-form" data-testid="document-version" data-effective-state={data.effectiveVersion?.id===version.id?"effective":new Date(version.effectiveFrom??version.createdAt)>new Date(data.observedAt)?"scheduled":"retained"}>
      <h3>{t("version",{number:version.number})}</h3><p dir="auto">{version.title}</p><p dir="auto">{version.fileName}</p><p>{formatDateTime(locale,new Date(version.createdAt))}</p><p dir="auto">{version.reason}</p>
      <p>{effective("effectiveAt",{at:formatDateTime(locale,new Date(version.effectiveFrom??version.createdAt),{timeZone:"UTC"})})}</p><p>{effective(data.effectiveVersion?.id===version.id?"effectiveVersion":new Date(version.effectiveFrom??version.createdAt)>new Date(data.observedAt)?"scheduledVersion":"retainedVersion")}</p>{!version.supersededById?<p>{effective("latestRecorded")}</p>:null}<div className="form-actions"><button className="secondary-button" disabled={disabled} onClick={()=>onDownload(version)} data-testid="document-download">{t("download")}</button>
      {!version.supersededById&&!data.document.archivedAt&&canAmend?<button className="secondary-button" disabled={disabled} onClick={()=>onAmend(version)} data-testid="document-amend">{t("addVersion")}</button>:null}{onSignature&&data.document.kind==="INSTANCE"&&version.contentType==="application/pdf"&&!data.document.archivedAt?<button className="secondary-button" disabled={disabled} onClick={()=>onSignature(version)} data-testid="document-prepare-signature">{signatures("prepare")}</button>:null}</div>
    </li>)}</ul>}
    <div className="form-actions">{data.effectiveVersion&&!data.versions.some(version=>version.id===data.effectiveVersion?.id)?<button className="secondary-button" disabled={disabled} onClick={onEffective} data-testid="document-show-effective">{effective("showEffective")}</button>:null}{data.next?<button className="secondary-button" disabled={disabled} onClick={onMore} data-testid="document-history-more">{t("olderVersions")}</button>:null}<button className="quiet-button" disabled={disabled} onClick={onCurrent}>{t("refreshHistory")}</button></div>
  </section>;
}
