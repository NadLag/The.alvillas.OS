import Link from "next/link";
import { randomUUID } from "node:crypto";
import { getTranslations } from "next-intl/server";
import { EmptyState, StatusBadge } from "@/design-system/shells";
import { calendarDateAt, formatCurrencyAmount, formatDate } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { canUseHousehold } from "../domain/household-access";
import { personalWorkspace } from "../application/personal-session";
import { PersonalTransferRepository } from "../application/personal-transfers";
import { PersonalForm } from "./personal-form";

export async function TransfersPanel({ locale, householdId, after }: { locale: AppLocale; householdId: string; after?: string }) {
  const [t, page] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }),
    personalWorkspace(locale, householdId, async (scope) => {
      const transfers = new PersonalTransferRepository(scope);
      const canEdit = canUseHousehold(scope.authority, scope.id, "transfers", "edit");
      const result = await transfers.list(after);
      return { ...result, canEdit, canConfirm: canEdit && result.items.some((item) => item.status === "PENDING") && await transfers.canConfirm() };
    })
  ]);
  return <section className="detail-panel">
    <h2>{t("sections.transfers")}</h2>
    {page.canEdit ? <details>
      <summary>{t("requestTransfer")}</summary>
      <PersonalForm target={{ locale, householdId, command: "requestTransfer" }}>
        <input name="id" type="hidden" value={randomUUID()} />
        <div className="form-grid two">
          <label>{t("transferDirection")}<select name="direction">
            <option value="TO_PERSONAL">{t("toPersonal")}</option>
            <option value="TO_BUSINESS">{t("toBusiness")}</option>
          </select></label>
          <label>{t("category")}<input name="category" maxLength={80} required /></label>
          <label>{t("amount")}<input name="amount" inputMode="decimal" maxLength={32} required /></label>
          <label>{t("currency")}<input name="currency" minLength={3} maxLength={3} required /></label>
          <label>{t("date")}<input type="date" name="effectiveOn" defaultValue={calendarDateAt(new Date(), "Africa/Casablanca")} required /></label>
        </div>
      </PersonalForm>
    </details> : null}
    {page.items.length ? <ul className="form-grid">
      {page.items.map((entry) => <li key={entry.id}>
        <div className="form-actions">
          <strong dir="auto">{entry.category}</strong>
          <span>{t(entry.direction === "TO_PERSONAL" ? "toPersonal" : "toBusiness")}</span>
          <bdi>{formatCurrencyAmount(locale, entry.amount, entry.currency)}</bdi>
          <time dateTime={entry.effectiveOn.toISOString().slice(0, 10)}>{formatDate(locale, entry.effectiveOn, { timeZone: "UTC" })}</time>
          <StatusBadge>{t(entry.status === "CONFIRMED" ? "confirmedTransfer" : entry.status === "CANCELLED" ? "cancelledTransfer" : "pendingTransfer")}</StatusBadge>
        </div>
        {entry.status === "PENDING" && page.canConfirm ? <details>
          <summary>{t("approveTransfer")}</summary>
          <PersonalForm target={{ locale, householdId, command: "confirmTransfer" }} submitLabel={t("approveTransfer")}>
            <input name="id" value={entry.id} type="hidden" />
            <label>{t("transferReference")}<input name="businessTransactionId" required /></label>
          </PersonalForm>
        </details> : null}
        {entry.status === "PENDING" && entry.requestedByMe && page.canEdit ? <PersonalForm target={{ locale, householdId, command: "cancelTransfer" }} submitLabel={t("cancelTransfer")}>
          <input name="id" value={entry.id} type="hidden" />
        </PersonalForm> : null}
      </li>)}
    </ul> : <EmptyState>{t("empty")}</EmptyState>}
    {page.next ? <Link className="secondary-button" prefetch={false} href={`?after=${page.next}`}>{t("next")}</Link> : null}
  </section>;
}
