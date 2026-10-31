"use client";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { formatCurrencyAmount,formatDate,formatDateTime } from "@/i18n/format";
import { localizedText } from "@/i18n/content";
import type { AppLocale } from "@/i18n/routing";
import type { employeeCompensationCostDetailSchema } from "../domain/employee-compensation-cost-workspace";
type Detail=z.infer<typeof employeeCompensationCostDetailSchema>;
export function CompensationCostEvidence({locale,costs,labels}:{locale:AppLocale;costs:Detail["costs"];labels:Detail["labels"]}){
  const t=useTranslations("CompensationCosts"),sourceText=useTranslations("CompensationRuns"),byLine=new Map(labels.map(label=>[label.lineId,label]));
  return <ol className="compensation-source-list">{costs.map(cost=>{
    const label=byLine.get(cost.runLineId);if(!label)return null;
    return <li className="compensation-source" key={cost.id} data-testid="compensation-cost-source"><div className="compensation-source-heading"><div><h3>{label.sourceTitle?localizedText(label.sourceTitle,locale):sourceText("completedWork")}</h3><p dir="auto">{label.propertyName??sourceText("restrictedProperty")}</p></div><strong className="compensation-numeric">{formatCurrencyAmount(locale,cost.amount.amount,cost.amount.currency)}</strong></div>
      <dl className="compensation-evidence"><div><dt>{sourceText("performer")}</dt><dd dir="auto">{label.personName??sourceText("restrictedPerson")}</dd></div><div><dt>{sourceText("contract")}</dt><dd dir="auto">{label.roleName}<small>{sourceText("contractVersion",{version:label.contractVersion,at:formatDate(locale,new Date(label.effectiveFrom),{timeZone:"UTC"})})}</small></dd></div><div><dt>{sourceText("completion")}</dt><dd>{sourceText(`methods.${label.completionMethod}`)}<small>{formatDateTime(locale,new Date(cost.recordedCompletionAt),{timeZone:cost.timezone})}</small>{label.completionMethod==="PROXY"?<small>{sourceText("validator")}: <span dir="auto">{label.validatorName??sourceText("restrictedPerson")}</span>{label.validatedAt?` · ${formatDateTime(locale,new Date(label.validatedAt),{timeZone:"UTC"})}`:""}</small>:null}</dd></div><div><dt>{t("category")}</dt><dd dir="auto">{cost.category}</dd></div>{cost.costCenter?<div><dt>{t("costCenter")}</dt><dd dir="auto">{cost.costCenter}</dd></div>:null}<div><dt>{t("note")}</dt><dd dir="auto">{cost.note}</dd></div></dl>
      <dl className="compensation-cost-allocation" aria-label={t("allocation")}>{(["owner","alvillas","guest"] as const).map(party=><div key={party}><dt>{t(`parties.${party}`)}</dt><dd>{formatCurrencyAmount(locale,cost.allocation[party].amount,cost.allocation[party].currency)}</dd></div>)}</dl>
    </li>;
  })}</ol>;
}
