"use client";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrencyAmount,formatDate } from "@/i18n/format";
import type { employeeCompensationRunDetailSchema } from "../domain/employee-compensation-workspace";
type Coverage=NonNullable<z.infer<typeof employeeCompensationRunDetailSchema>["labels"][number]["monthlyCoverage"]>;
export function CompensationMonthlyEvidence({locale,coverage}:{locale:AppLocale;coverage:Coverage}){
 const t=useTranslations("CompensationRuns"),date=(on:string)=>formatDate(locale,new Date(on+"T12:00:00Z"),{timeZone:"UTC"});
 return <section data-testid="compensation-monthly-evidence" aria-label={t("monthlyEvidence")}><h4>{t("monthlyEvidence")}</h4><dl className="compensation-evidence"><div><dt>{t("contractMonth")}</dt><dd>{formatDate(locale,new Date(coverage.month+"-01T12:00:00Z"),{dateStyle:undefined,timeZone:"UTC",year:"numeric",month:"long"})}</dd></div><div><dt>{t("monthlyCoverage")}</dt><dd>{t("monthlyDays",{eligible:coverage.eligibleDays,total:coverage.calendarDays})}</dd></div><div><dt>{t("monthlyRateChoice")}</dt><dd>{t(`monthlyRateChoices.${coverage.rateSelection}`)}</dd></div><div><dt>{t("monthlyProration")}</dt><dd>{t(`monthlyProrations.${coverage.proration}`)}</dd></div></dl><h4>{t("monthlyAppliedRates")}</h4><ol>{coverage.rates.map(rate=><li key={rate.fromOn}><p>{t("monthlyRate",{amount:formatCurrencyAmount(locale,rate.rate.amount,rate.rate.currency)})}</p><p>{date(rate.fromOn)} {t("through")} {date(rate.toOn)}</p><p>{t("monthlyRateDays",{days:rate.days,version:rate.contractVersion})}</p></li>)}</ol><p>{t("monthlyRounding")}</p></section>;
}
