"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { EmptyState,SkeletonBlock,StatusBadge } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate,formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationRunListSchema } from "../domain/employee-compensation-workspace";
import { useCompensationRead } from "./use-compensation-read";

export function CompensationRunList({locale,query,state,after}:{locale:AppLocale;query:string;state:string;after?:string}){
  const t=useTranslations("CompensationRuns"),monthly=useTranslations("MonthlyCompensation"),hourly=useTranslations("HourlyCompensation"),params=new URLSearchParams({query,state});if(after)params.set("after",after);
  const resource=useCompensationRead(`/api/finance/compensation/runs/list?${params}`,employeeCompensationRunListSchema);
  const next=new URLSearchParams({q:query,state});if(resource.data?.next)next.set("after",resource.data.next);
  return <div aria-busy={resource.pending} data-testid="compensation-list">
    {resource.data?.canCreate?<div className="app-actions"><Link className="primary-button" href={`/${locale}/app/finance/compensation/new`} prefetch={false} data-testid="compensation-new">{t("create")}</Link><Link className="secondary-button" href={`/${locale}/app/finance/compensation/monthly/new`} prefetch={false} data-testid="compensation-new-monthly">{monthly("create")}</Link><Link className="secondary-button" href={`/${locale}/app/finance/compensation/hourly/new`} prefetch={false} data-testid="compensation-new-hourly">{hourly("create")}</Link></div>:null}
    <form className="compensation-filters" method="get">
      <label className="field"><span>{t("search")}</span><input type="search" name="q" defaultValue={query} maxLength={160} dir="auto" data-testid="compensation-search" /></label>
      <label className="field"><span>{t("state")}</span><select name="state" defaultValue={state} data-testid="compensation-state"><option value="all">{t("allStates")}</option><option value="draft">{t("states.DRAFT")}</option><option value="cancelled">{t("states.CANCELLED")}</option></select></label>
      <button type="submit" className="secondary-button">{t("filter")}</button>
    </form>
    {resource.pending?<><p role="status">{t("loading")}</p><SkeletonBlock rows={4}/></>:null}
    {resource.error?<div role="alert" className="compensation-notice" data-testid="compensation-error"><p>{t(resource.error)}</p><button className="secondary-button" type="button" onClick={()=>{void resource.refresh();}}>{t("retryRead")}</button></div>:null}
    {resource.data?.runs.length===0?<EmptyState testId="compensation-empty">{t("empty")}</EmptyState>:null}
    {resource.data?.runs.length?<div className="compensation-table-scroll" role="region" aria-label={t("savedRuns")} tabIndex={0}><table className="compensation-table"><caption className="sr-only">{t("savedRuns")}</caption><thead><tr><th scope="col">{t("purpose")}</th><th scope="col">{t("period")}</th><th scope="col">{t("state")}</th><th scope="col">{t("workCount")}</th><th scope="col">{t("expected")}</th></tr></thead>
      <tbody>{resource.data.runs.map(run=><tr key={run.id} data-testid="compensation-run-row"><th scope="row"><Link href={`/${locale}/app/finance/compensation/${run.id}`} prefetch={false} data-testid="compensation-open" dir="auto">{run.purpose}</Link><small>{t("createdAt",{at:formatDateTime(locale,new Date(run.createdAt),{timeZone:run.timezone})})}</small></th>
        <td>{formatDate(locale,new Date(run.fromOn+"T12:00:00Z"),{timeZone:"UTC"})}<span className="compensation-date-to">{t("through")}</span>{formatDate(locale,new Date(run.toOn+"T12:00:00Z"),{timeZone:"UTC"})}<small>{run.timezone}</small></td>
        <td><StatusBadge tone={run.state==="CANCELLED"?"neutral":"warning"}>{t(`states.${run.state}`)}</StatusBadge></td><td className="compensation-numeric">{new Intl.NumberFormat(locale).format(run.lineCount)}</td><td className="compensation-numeric">{formatCurrencyAmount(locale,run.total.amount,run.total.currency)}</td></tr>)}</tbody></table></div>:null}
    {resource.data?.next?<Link className="secondary-button" href={`/${locale}/app/finance/compensation?${next}`} prefetch={false} data-testid="compensation-next">{t("next")}</Link>:null}
  </div>;
}
