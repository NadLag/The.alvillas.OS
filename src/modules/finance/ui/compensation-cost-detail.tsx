"use client";
import Link from "next/link";
import { useCallback,useEffect,useRef,useState,type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { SkeletonBlock,StatusBadge } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate,formatDateTime } from "@/i18n/format";
import { CompensationCostEvidence } from "./compensation-cost-evidence";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationCostDetailSchema } from "../domain/employee-compensation-cost-workspace";
import { useCompensationRead } from "./use-compensation-read";

const reasonSchema=z.string().trim().min(6).max(500),receiptSchema=z.object({id:z.uuid(),runId:z.uuid(),state:z.literal("WITHDRAWN")}).passthrough();
export function CompensationCostDetail({locale,submissionId,after}:{locale:AppLocale;submissionId:string;after?:string}){
  const t=useTranslations("CompensationCosts");
  const [reason,setReason]=useState(""),[pending,setPending]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<string|null>(null),intent=useRef<string|null>(null),busy=useRef(false),generation=useRef(0);
  const invalidate=useCallback(()=>{generation.current++;intent.current=null;setReason("");setUncertain(false);setError(null);},[]);
  useEffect(()=>()=>{generation.current++;intent.current=null;},[]);
  const query=after?`?${new URLSearchParams({after})}`:"",resource=useCompensationRead(`/api/finance/compensation/submissions/${submissionId}/detail${query}`,employeeCompensationCostDetailSchema,invalidate),data=resource.data;
  async function withdraw(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy.current||!data||!navigator.onLine)return;const parsed=reasonSchema.safeParse(intent.current??reason);if(!parsed.success){setError("validation");return;}
    intent.current=parsed.data;busy.current=true;setPending(true);setError(null);const own=generation.current;
    try{
      const response=await fetch(`/api/finance/compensation/submissions/${submissionId}/withdraw`,{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({reason:parsed.data})});
      if(own!==generation.current)return;if(response.status===401||response.status===403){resource.clear("forbidden");return;}if(!response.ok)throw Error("Withdrawal acknowledgement unavailable");
      const receipt=receiptSchema.parse(await response.json());if(own!==generation.current)return;if(receipt.id!==submissionId||receipt.runId!==data.runId)throw Error("Different withdrawal acknowledgement");
      intent.current=null;setReason("");setUncertain(false);await resource.refresh();
    }catch{if(own===generation.current){setUncertain(true);setError("withdrawUncertain");}}finally{busy.current=false;setPending(false);}
  }
  return <div aria-busy={resource.pending} data-testid="compensation-cost-detail">
    {resource.pending?<><p role="status">{t("loading")}</p><SkeletonBlock rows={5}/></>:null}
    {resource.error?<div role="alert" className="compensation-notice"><p>{t(resource.error)}</p><button className="secondary-button" onClick={()=>{void resource.refresh();}}>{t("retryRead")}</button></div>:null}
    {data?<><section className="compensation-summary"><div><StatusBadge tone={data.state==="APPROVED"?"success":data.state==="PENDING_APPROVAL"?"warning":"neutral"}><span data-testid="compensation-cost-state">{t(`states.${data.state}`)}</span></StatusBadge><h2 dir="auto">{data.purpose}</h2><p>{t("detailGuidance")}</p><div className="app-actions"><Link className="secondary-button" href={`/${locale}/app/finance/compensation/proposals/${submissionId}/claims`} prefetch={false} data-testid="compensation-cost-claims">{t("beneficiaryClaims")}</Link><Link className="secondary-button" href={`/${locale}/app/finance/compensation/${data.runId}/costs`} prefetch={false}>{t("backCosts")}</Link><Link className="secondary-button" href={`/${locale}/app/finance/compensation/${data.runId}`} prefetch={false}>{t("originalRun")}</Link>{data.canOpenApproval&&data.approvalId?<Link className="primary-button" href={`/${locale}/app/approvals/${data.approvalId}`} prefetch={false} data-testid="compensation-cost-open-approval">{t("review")}</Link>:null}</div></div><dl><div><dt>{t("proposalTotal")}</dt><dd className="compensation-total" data-testid="compensation-cost-total">{formatCurrencyAmount(locale,data.total.amount,data.total.currency)}</dd></div><div><dt>{t("costOn")}</dt><dd>{formatDate(locale,new Date(data.costOn+"T12:00:00Z"),{timeZone:"UTC"})}</dd></div><div><dt>{t("includedWork")}</dt><dd>{t("counts",{people:data.claimCount,work:data.costCount})}</dd></div></dl></section>
    <section aria-labelledby="compensation-cost-sources"><h2 id="compensation-cost-sources">{t("sourceEvidence")}</h2><CompensationCostEvidence locale={locale} costs={data.costs} labels={data.labels}/><div className="app-actions">{after?<Link className="secondary-button" href={`/${locale}/app/finance/compensation/proposals/${submissionId}`} prefetch={false}>{t("firstPage")}</Link>:null}{data.nextCursor?<Link className="secondary-button" href={`/${locale}/app/finance/compensation/proposals/${submissionId}?${new URLSearchParams({after:data.nextCursor})}`} prefetch={false}>{t("nextPage")}</Link>:null}</div></section>
    <section className="compensation-history" aria-labelledby="compensation-cost-history"><h2 id="compensation-cost-history">{t("history")}</h2><ol>{data.history.map(event=><li key={event.action}><strong>{t(`historyActions.${event.action}`)}</strong><time dateTime={event.at}>{formatDateTime(locale,new Date(event.at),{timeZone:"UTC"})}</time><p dir="auto">{event.reason}</p></li>)}</ol></section>
    {data.canWithdraw?<form className="resource-form compensation-cancellation" data-testid="compensation-cost-withdraw-form" aria-busy={pending} onSubmit={event=>{void withdraw(event);}}><h2>{t("withdrawTitle")}</h2><p>{t("withdrawGuidance")}</p>{error?<p role="alert" data-testid="compensation-cost-withdraw-error">{t(error)}</p>:null}<fieldset disabled={pending}><legend className="sr-only">{t("withdrawTitle")}</legend><label className="field"><span>{t("withdrawReason")}</span><textarea required minLength={6} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} readOnly={uncertain} dir="auto" data-testid="compensation-cost-withdraw-reason"/></label><button className="secondary-button" data-testid="compensation-cost-withdraw">{t(pending?"withdrawing":uncertain?"retryWithdrawal":"withdraw")}</button></fieldset></form>:null}
    </>:null}
  </div>;
}
