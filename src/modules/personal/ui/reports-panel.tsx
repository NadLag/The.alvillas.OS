import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/design-system/shells";
import { formatCurrencyAmount } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { canUseHousehold } from "../domain/household-access";
import { financeKindSchema } from "../domain/personal-finance";
import { totalsByCurrency } from "../domain/report-totals";
import { PersonalTransferRepository } from "../application/personal-transfers";
import { personalWorkspace } from "../application/personal-session";

export async function ReportsPanel({ locale, householdId, from, through, mode = "reports" }: {
  locale: AppLocale; householdId: string; from: string; through: string; mode?: "reports" | "positions";
}) {
  const [t, report] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }),
    personalWorkspace(locale, householdId, async (scope, finance) => ({
      rows: await finance.report(from, through, mode),
      transfers: mode === "reports" && canUseHousehold(scope.authority, householdId, "transfers")
        ? await new PersonalTransferRepository(scope).settledTotals(from, through) : [],
      cash: canUseHousehold(scope.authority, householdId, "income") && canUseHousehold(scope.authority, householdId, "expenses")
    }))
  ]);
  const amount = (value: string, currency: string) => formatCurrencyAmount(locale, value, currency);
  const netWorth = totalsByCurrency(report.rows, ["LIABILITY"], ["ASSET", "INVESTMENT"]);
  const cashFlow = mode === "reports" && report.cash ? totalsByCurrency(report.rows, ["EXPENSE"], ["INCOME"]) : [];
  return <section className="detail-panel">
    <h2>{t(mode === "positions" ? "netWorth" : "sections.reports")}</h2>
    {mode === "reports" ? <form method="get" className="form-actions">
      <label>{t("from")}<input type="date" name="from" defaultValue={from} required /></label>
      <label>{t("through")}<input type="date" name="through" defaultValue={through} required /></label>
      <button type="submit" className="secondary-button">{t("applyDates")}</button>
    </form> : null}
    <dl>
      {netWorth.map((total) => <div className="form-actions" key={total.currency}>
        <dt>{t("netWorth")}</dt><dd><bdi>{amount(total.amount, total.currency)}</bdi></dd>
      </div>)}
      {report.transfers.map((total) => <div className="form-actions" key={total.currency}>
        <dt>{t("sections.transfers")}</dt><dd><bdi>{amount(total.amount, total.currency)}</bdi></dd>
      </div>)}
      {cashFlow.map((total) => <div className="form-actions" key={total.currency}>
        <dt>{t("cashFlow")}</dt><dd><bdi>{amount(total.amount, total.currency)}</bdi></dd>
      </div>)}
    </dl>
    {mode === "reports" ? report.rows.length ? <ul className="form-grid">
      {report.rows.map((row) => (
        <li className="form-actions" key={JSON.stringify([row.kind, row.category, row.currency])}>
          <strong>{t(`kinds.${financeKindSchema.parse(row.kind)}`)}</strong>
          <span dir="auto">{row.category}</span>
          <bdi>{amount(row.amount, row.currency)}</bdi>
        </li>
      ))}
    </ul> : <EmptyState>{t("empty")}</EmptyState> : null}
  </section>;
}
