"use client";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import type { bankReconciliationPlanSchema } from "../domain/bank-reconciliation-command";

export function BankReconciliationPlan({ plan, locale }: { plan: z.infer<typeof bankReconciliationPlanSchema>; locale: AppLocale }) {
  const t = useTranslations("BankReconciliation"), currency = plan.unit.slice(6);
  return <section className="resource-form" data-testid="bank-match-plan"><h3>{t("review")}</h3><dl>
    <dt>{t("expected")}</dt><dd>{formatCurrencyAmount(locale, plan.expected, currency)}</dd>
    <dt>{t("actual")}</dt><dd>{formatCurrencyAmount(locale, plan.actual, currency)}</dd>
    <dt>{t("variance")}</dt><dd data-testid="bank-match-variance">{formatCurrencyAmount(locale, plan.variance, currency)}</dd>
    <dt>{t("classification")}</dt><dd>{t(`classification_${plan.classification}`)}</dd>
    <dt>{t("reason")}</dt><dd dir="auto">{plan.reason}</dd>
    {plan.varianceAction ? <><dt>{t("varianceAction")}</dt><dd dir="auto">{plan.varianceAction}</dd></> : null}
  </dl>{plan.evidence.length ? <p data-testid="bank-match-removal-evidence">{t("retainedRemovals", { count: plan.evidence.length })}</p> : null}</section>;
}
