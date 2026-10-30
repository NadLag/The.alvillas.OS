"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { EmptyState,SkeletonBlock,StatusBadge } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationCostWorkspaceSchema } from "../domain/employee-compensation-cost-workspace";
import { useCompensationRead } from "./use-compensation-read";

export function CompensationCostNavigation({locale,runId}:{locale:AppLocale;runId:string}){
  const t=useTranslations("CompensationCosts"),resource=useCompensationRead(`/api/finance/compensation/runs/${runId}/cost-workspace`,employeeCompensationCostWorkspaceSchema);
  if(!resource.data)return null;
  return <div className="app-actions compensation-cost-actions"><Link className="secondary-button" href={`/${locale}/app/finance/compensation/${runId}/costs`} prefetch={false} data-testid="compensation-open-costs">{t("title")}</Link>{resource.data.canPrepare?<Link className="primary-button" href={`/${locale}/app/finance/compensation/${runId}/costs/new`} prefetch={false}>{t("prepare")}</Link>:null}</div>;
}

export function CompensationCostList({locale,runId,after}:{locale:AppLocale;runId:string;after?:string}){
  const t=useTranslations("CompensationCosts"),query=after?`?${new URLSearchParams({after})}`:"",resource=useCompensationRead(`/api/finance/compensation/runs/${runId}/cost-workspace${query}`,employeeCompensationCostWorkspaceSchema),data=resource.data;
  return <div aria-busy={resource.pending} data-testid="compensation-cost-list">
    {resource.pending?<><p role="status">{t("loading")}</p><SkeletonBlock rows={4}/></>:null}
    {resource.error?<div role="alert" className="compensation-notice"><p>{t(resource.error)}</p><button className="secondary-button" onClick={()=>{void resource.refresh();}}>{t("retryRead")}</button></div>:null}
    {data?<><section className="compensation-summary"><div><h2 dir="auto">{data.run.purpose}</h2><p>{t("description")}</p>{data.canPrepare?<Link className="primary-button" href={`/${locale}/app/finance/compensation/${runId}/costs/new`} prefetch={false} data-testid="compensation-prepare-costs">{t("prepare")}</Link>:data.blocked?<p data-testid="compensation-cost-blocked">{t(`blocked.${data.blocked}`)}</p>:null}</div><dl><div><dt>{t("originalTotal")}</dt><dd className="compensation-total">{formatCurrencyAmount(locale,data.run.total.amount,data.run.total.currency)}</dd></div><div><dt>{t("workCount")}</dt><dd>{new Intl.NumberFormat(locale).format(data.run.lineCount)}</dd></div></dl></section>
      {data.proposals.length===0?<EmptyState testId="compensation-cost-empty">{t("empty")}</EmptyState>:<ul className="compensation-source-list">{data.proposals.map(proposal=><li className="compensation-source" key={proposal.id}><div className="compensation-source-heading"><div><StatusBadge tone={proposal.state==="APPROVED"?"success":proposal.state==="PENDING_APPROVAL"?"warning":"neutral"}>{t(`states.${proposal.state}`)}</StatusBadge><h3><Link href={`/${locale}/app/finance/compensation/proposals/${proposal.id}`} prefetch={false} data-testid="compensation-cost-proposal">{t("proposalOn",{date:formatDate(locale,new Date(proposal.costOn+"T12:00:00Z"),{timeZone:"UTC"})})}</Link></h3><p>{t("counts",{people:proposal.claimCount,work:proposal.costCount})}</p></div><strong className="compensation-numeric">{formatCurrencyAmount(locale,proposal.total.amount,proposal.total.currency)}</strong></div></li>)}</ul>}
      <div className="app-actions">{after?<Link className="secondary-button" href={`/${locale}/app/finance/compensation/${runId}/costs`} prefetch={false}>{t("firstPage")}</Link>:null}{data.next?<Link className="secondary-button" href={`/${locale}/app/finance/compensation/${runId}/costs?${new URLSearchParams({after:data.next})}`} prefetch={false}>{t("nextPage")}</Link>:null}</div>
    </>:null}
  </div>;
}
