"use client";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import type { documentHistorySchema,documentVersionItemSchema } from "../domain/document-read-model";

type Version=z.infer<typeof documentVersionItemSchema>;
export function DocumentHistoryPanel({locale,data,disabled,canAmend,onMore,onCurrent,onDownload,onAmend}:{locale:AppLocale;data:z.infer<typeof documentHistorySchema>;disabled:boolean;canAmend:boolean;onMore:()=>void;onCurrent:()=>void;onDownload:(version:Version)=>void;onAmend:(version:Version)=>void}){
  const t=useTranslations("DocumentArchive");
  return <section className="resource-form" data-testid="document-history"><h2 dir="auto">{data.document.title}</h2><p>{t("historyGuidance")}</p>
    {!data.versions.length?<p>{t("noVersions")}</p>:<ul className="resource-list">{data.versions.map(version=><li key={version.id} className="resource-form" data-testid="document-version">
      <h3>{t("version",{number:version.number})}</h3><p dir="auto">{version.title}</p><p dir="auto">{version.fileName}</p><p>{formatDateTime(locale,new Date(version.createdAt))}</p><p dir="auto">{version.reason}</p>
      <p>{t(version.supersededById?"retainedVersion":"currentVersion")}</p><div className="form-actions"><button className="secondary-button" disabled={disabled} onClick={()=>onDownload(version)} data-testid="document-download">{t("download")}</button>
      {!version.supersededById&&data.document.kind!=="INSTANCE"&&!data.document.archivedAt&&canAmend?<button className="secondary-button" disabled={disabled} onClick={()=>onAmend(version)} data-testid="document-amend">{t("addVersion")}</button>:null}</div>
    </li>)}</ul>}
    <div className="form-actions">{data.next?<button className="secondary-button" disabled={disabled} onClick={onMore} data-testid="document-history-more">{t("olderVersions")}</button>:null}<button className="quiet-button" disabled={disabled} onClick={onCurrent}>{t("refreshHistory")}</button></div>
  </section>;
}
