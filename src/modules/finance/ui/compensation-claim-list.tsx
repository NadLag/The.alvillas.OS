"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SkeletonBlock,StatusBadge } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationClaimWorkspaceSchema } from "../domain/employee-compensation-claim-workspace";
import { useCompensationRead } from "./use-compensation-read";
export function CompensationClaimList({locale,submissionId,after}:{locale:AppLocale;submissionId:string;after?:string}){
  const t=useTranslations("CompensationClaims"),costText=useTranslations("CompensationCosts"),sourceText=useTranslations("CompensationRuns"),base=`/${locale}/app/finance/compensation/proposals/${submissionId}/claims`;
  const resource=useCompensationRead(`/api/finance/compensation/submissions/${submissionId}/claims${after?`?${new URLSearchParams({after})}`:""}`,employeeCompensationClaimWorkspaceSchema),data=resource.data;
  return <div aria-busy={resource.pending} data-testid="compensation-claim-list">
    {resource.pending?<><p role="status">{costText("loading")}</p><SkeletonBlock rows={4}/></>:null}
    {resource.error?<div role="alert" className="compensation-notice"><p>{costText(resource.error)}</p><button className="secondary-button" onClick={()=>{void resource.refresh();}}>{costText("retryRead")}</button></div>:null}
    {data?<><section className="compensation-summary"><div><StatusBadge tone={data.source.state==="APPROVED"?"success":"neutral"}>{costText(`states.${data.source.state}`)}</StatusBadge><h2 dir="auto">{data.source.purpose}</h2><p>{t("listGuidance")}</p></div><dl><div><dt>{costText("proposalTotal")}</dt><dd className="compensation-total">{formatCurrencyAmount(locale,data.source.total.amount,data.source.total.currency)}</dd></div><div><dt>{costText("costOn")}</dt><dd>{formatDate(locale,new Date(data.source.costOn+"T12:00:00Z"),{timeZone:"UTC"})}</dd></div><div><dt>{t("beneficiaries")}</dt><dd>{new Intl.NumberFormat(locale).format(data.claimCount)}</dd></div></dl></section>
      <ol className="compensation-source-list">{data.claims.map(claim=><li key={claim.id} className="compensation-source" data-testid="compensation-claim-row"><div className="compensation-source-heading"><div><h3 dir="auto">{claim.personName??sourceText("restrictedPerson")}</h3><p>{t("workCount",{count:claim.costCount})}</p></div><strong className="compensation-numeric" data-testid="compensation-claim-amount">{formatCurrencyAmount(locale,claim.amount.amount,claim.amount.currency)}</strong></div><div className="app-actions"><StatusBadge tone={claim.recognized?"success":claim.pending?"warning":"neutral"}>{t(claim.recognized?"recognized":claim.pending?"pending":"unrecognized")}</StatusBadge>{claim.canOpen?<Link className="secondary-button" prefetch={false} href={`${base}/${claim.id}`} data-testid="compensation-claim-open">{t("openClaim")}</Link>:<span>{t("detailRestricted")}</span>}</div></li>)}</ol>
      <nav className="app-actions" aria-label={t("pagination")}>{after?<Link className="secondary-button" href={base} prefetch={false}>{costText("firstPage")}</Link>:null}{data.next?<Link className="secondary-button" href={`${base}?${new URLSearchParams({after:data.next})}`} prefetch={false}>{costText("nextPage")}</Link>:null}</nav>
    </>:null}
  </div>;
}
