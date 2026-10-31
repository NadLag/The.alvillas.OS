"use client";
import { useTranslations } from "next-intl";
import { SkeletonBlock,StatusBadge } from "@/design-system/shells";
import { formatCurrencyAmount,formatDate } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationNoticeSchema } from "../domain/employee-compensation-notice";
import { useCompensationRead } from "./use-compensation-read";

export function EmployeeCompensationNotice({locale,id}:{locale:AppLocale;id:string}){
  const t=useTranslations("EmployeeCostNotices"),resource=useCompensationRead(`/api/finance/compensation/owner-notices/${id}`,employeeCompensationNoticeSchema),notice=resource.data;
  return <section className="employee-cost-notice" aria-busy={resource.pending} data-testid="employee-cost-owner-notice">
    {resource.pending?<><p role="status">{t("loading")}</p><SkeletonBlock rows={3}/></>:null}
    {resource.error?<div role="alert" className="compensation-notice"><p>{t(resource.error)}</p><button className="secondary-button" onClick={()=>{void resource.refresh();}}>{t("retry")}</button></div>:null}
    {notice?<><StatusBadge tone="neutral">{t(notice.withdrawn?"withdrawn":"retained")}</StatusBadge><h2 dir="auto">{notice.propertyName??t("restrictedProperty")}</h2><p dir="auto" data-testid="employee-cost-notice-note">{notice.purpose}</p><dl className="detail-grid"><div><dt>{t("gross")}</dt><dd data-testid="employee-cost-notice-gross">{formatCurrencyAmount(locale,notice.amount,notice.currency)}</dd></div><div><dt>{t("allocation")}</dt><dd data-testid="employee-cost-notice-allocation">{formatCurrencyAmount(locale,notice.ownerAmount,notice.currency)}</dd></div><div><dt>{t("category")}</dt><dd dir="auto">{notice.category}</dd></div><div><dt>{t("date")}</dt><dd>{formatDate(locale,new Date(notice.occurredOn+"T12:00:00Z"),{timeZone:"UTC"})}</dd></div></dl><p>{t(notice.withdrawn?"withdrawnGuidance":"paymentGuidance")}</p></>:null}
  </section>;
}
