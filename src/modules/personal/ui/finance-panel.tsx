import Link from "next/link";
import { randomUUID } from "node:crypto";
import { getTranslations } from "next-intl/server";
import { EmptyState, StatusBadge } from "@/design-system/shells";
import { calendarDateAt, formatCurrencyAmount, formatDate } from "@/i18n/format";
import { Money } from "@/platform/money/money";
import type { AppLocale } from "@/i18n/routing";
import { canUseHousehold } from "../domain/household-access";
import { dayValue, financeAreas, isMovement, signedMoney, type FinanceKind } from "../domain/personal-finance";
import { personalWorkspace } from "../application/personal-session";
import { PersonalForm } from "./personal-form";

type Props = {
  locale: AppLocale; householdId: string; kind: FinanceKind;
  after?: { id: string; effectiveOn: string }; series?: string;
};

export async function FinancePanel({ locale, householdId, kind, after, series }: Props) {
  const area = financeAreas[kind];
  const today = calendarDateAt(new Date(), "Africa/Casablanca");
  const [t, page] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }),
    personalWorkspace(locale, householdId, async (scope, finance) => {
      const entries = await finance.list(kind, after, series);
      const goals = kind === "SAVINGS_GOAL"
        ? await finance.savingsProgress(entries.items.map((entry) => entry.seriesId), today) : {};
      const budgetSpending = kind === "BUDGET" ? await finance.budgetSpending(entries.items) : null;
      const canEdit = canUseHousehold(scope.authority, scope.id, area, "edit");
      const goalOptions = kind === "SAVINGS_MOVEMENT" && canEdit
        ? (await finance.list("SAVINGS_GOAL")).items.filter((entry) => !entry.closed) : [];
      return { ...entries, goals, budgetSpending, canEdit, goalOptions };
    })
  ]);

  const target = { locale, householdId, command: "finance" as const };
  const path = `/${locale}/personal/${householdId}/${area}`;
  const query = (values: Record<string, string>) => path + "?" + new URLSearchParams({
    kind, ...(series ? { series } : {}), ...values
  }).toString();
  function entryForm(existing?: (typeof page.items)[number]) {
    return <PersonalForm target={target}>
      <input type="hidden" name="id" value={randomUUID()} />
      <input type="hidden" name="kind" value={kind} />
      {existing ? <input type="hidden" name="seriesId" value={existing.seriesId} /> : null}
      <div className="form-grid two">
        <label>{t("name")}<input name="label" maxLength={120} defaultValue={existing?.label} required /></label>
        <label>{t("category")}<input name="category" maxLength={80} defaultValue={existing?.category} readOnly={existing && kind === "BUDGET"} required /></label>
        <label>{t("amount")}<input name="amount" inputMode="decimal" maxLength={32} defaultValue={existing?.amount} required /></label>
        <label>{t("currency")}<input name="currency" maxLength={3} minLength={3} defaultValue={existing?.currency} readOnly={Boolean(existing)} required /></label>
        {kind === "BUDGET"
          ? <label>{t("month")}<input type="date" name="effectiveOn" defaultValue={existing?.effectiveOn ?? today} readOnly={Boolean(existing)} required /></label>
          : <label>{t("date")}<input type="date" name="effectiveOn" defaultValue={existing && existing.effectiveOn > today ? existing.effectiveOn : today} required /></label>}
        {kind === "SAVINGS_MOVEMENT" ? <>
          <label>{t("goal")}<select name="goalId" required defaultValue={series}>
            {page.goalOptions.map((goal) => <option key={goal.seriesId} value={goal.seriesId}>{goal.label} ({goal.currency})</option>)}
          </select></label>
          <label><input name="withdrawal" type="checkbox" /> {t("withdrawal")}</label>
        </> : null}
        {existing ? <label><input name="closed" type="checkbox" defaultChecked={existing.closed} /> {t("closed")}</label> : null}
      </div>
    </PersonalForm>;
  }

  return <section className="detail-panel" aria-label={t(`kinds.${kind}`)}>
    <h2>{t(`kinds.${kind}`)}</h2>
    {series ? <Link className="secondary-button" prefetch={false} href={`${path}?kind=${kind}`}>{t("allRecords")}</Link> : null}
    {page.canEdit && (!series || kind === "SAVINGS_MOVEMENT") && (kind !== "SAVINGS_MOVEMENT" || page.goalOptions.length)
      ? <details><summary>{t("addRecord")}</summary>{entryForm()}</details> : null}
    {page.items.length ? <ul className="form-grid">
      {page.items.map((entry) => (
        <li key={entry.id}>
          <div className="form-actions">
            <strong dir="auto">{entry.label}</strong>
            <span dir="auto">{entry.category}</span>
            <bdi>{formatCurrencyAmount(locale, signedMoney(entry).amount, entry.currency)}</bdi>
            <time dateTime={entry.effectiveOn}>{formatDate(locale, dayValue(entry.effectiveOn), { timeZone: "UTC" })}</time>
            {entry.closed ? <StatusBadge>{t("closed")}</StatusBadge> : null}
            {entry.reversesId ? <StatusBadge>{t("reversal")}</StatusBadge> : null}
            {page.budgetSpending ? <span>{t("budgetRemaining", {
              amount: formatCurrencyAmount(locale, Money.of(entry.amount, entry.currency)
                .subtract(Money.of(page.budgetSpending[entry.seriesId] ?? "0", entry.currency)).amount, entry.currency)
            })}</span> : null}
            {kind === "SAVINGS_GOAL" ? <span>{t("savedAmount", { amount: formatCurrencyAmount(locale, page.goals[entry.seriesId] ?? "0", entry.currency) })}</span> : null}
          </div>
          {!isMovement(kind) && !series ? <Link prefetch={false} href={query({ series: entry.seriesId })}>{t("history")}</Link> : null}
          {page.canEdit && !series && !isMovement(kind) ? <details><summary>{t("revise")}</summary>{entryForm(entry)}</details> : null}
          {page.canEdit && isMovement(kind) && !entry.reversesId ? <details>
            <summary>{t("reverse")}</summary>
            <PersonalForm target={{ locale, householdId, command: "reverse" }} submitLabel={t("reverse")}>
              <input type="hidden" name="id" value={randomUUID()} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="sourceId" value={entry.id} />
              <label>{t("reason")}<input name="reason" required maxLength={240} /></label>
            </PersonalForm>
          </details> : null}
        </li>
      ))}
    </ul> : <EmptyState>{t("empty")}</EmptyState>}
    {page.next ? <Link className="secondary-button" prefetch={false} href={query({ after: page.next.id, cursorDate: page.next.effectiveOn })}>{t("next")}</Link> : null}
  </section>;
}
