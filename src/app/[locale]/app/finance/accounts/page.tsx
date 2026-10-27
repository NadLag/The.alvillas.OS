import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { listPaymentAccounts, PaymentAccountAccessError } from "@/modules/finance/application/payment-account-service";
import { PaymentAccountForm } from "@/modules/finance/ui/payment-account-form";
import { getExpenseEditor, ExpenseAccessError } from "@/modules/finance/application/expense-service";
import { isExpenseFundingAccount } from "@/modules/finance/domain/expense";

export const dynamic = "force-dynamic";
export default async function FinancialAccountsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; after?: string; propertyId?: string }>;
}) {
  const { locale: value } = await params, locale = safeLocale(value); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const query = await searchParams, t = await getTranslations("FinancialAccounts");
  let result;
  try {
    result = await listPaymentAccounts(actor, { query: query.q, after: query.after });
    if (query.propertyId) await getExpenseEditor(actor, query.propertyId);
  }
  catch (error) { if (error instanceof PaymentAccountAccessError || error instanceof ExpenseAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const next = new URLSearchParams({ ...(query.q ? { q: query.q } : {}), ...(result.next ? { after: result.next } : {}), ...(query.propertyId ? { propertyId: query.propertyId } : {}) });
  return <AdminShell className="resource-page financial-accounts-page" testId="financial-accounts-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")}
      actions={<Link className="secondary-button" href={query.propertyId ? `/${locale}/app/properties/${query.propertyId}/expenses/new` : `/${locale}/app`}>{t(query.propertyId ? "backToExpense" : "back")}</Link>} />
    <Link className="secondary-button" data-testid="financial-transfers-entry" href={`/${locale}/app/finance/transfers`}>{t("transfers")}</Link>
    <form className="resource-form" method="get" data-testid="payment-account-search-form">
      {query.propertyId ? <input type="hidden" name="propertyId" value={query.propertyId} /> : null}
      <label className="field"><span>{t("search")}</span><input name="q" data-testid="payment-account-search" defaultValue={query.q ?? ""} maxLength={120} /></label>
      <div className="form-actions"><button className="secondary-button" type="submit">{t("search")}</button></div>
    </form>
    {result.canConfigure ? <PaymentAccountForm /> : null}
    <section aria-label={t("chart")}>
      <h2>{t("chart")}</h2><p>{t("separation")}</p>
      {!result.accounts.length ? <p data-testid="payment-account-empty">{t("empty")}</p> : <ul className="resource-list">
        {result.accounts.map(account => {
          const group = ["ASSET_LOCATION", "ASSET", "STAFF_WALLET"].includes(account.accountType) ? "location" :
            ["CLAIM_OWNERSHIP", "CLAIM", "LIABILITY"].includes(account.accountType) ? "ownership" : "company";
          return <li className="resource-card" data-testid="payment-account-row" key={account.id}>
            <h3>{account.name}</h3><dl className="detail-grid">
              <div><dt>{t("code")}</dt><dd><code>{account.code}</code></dd></div>
              <div><dt>{t("category")}</dt><dd>{t(`groups.${group}`)}</dd></div>
              <div><dt>{t("normalSide")}</dt><dd>{t(account.normalSide === "DEBIT" ? "debit" : "credit")}</dd></div>
              <div><dt>{t("status")}</dt><dd>{t(account.archivedAt ? "archived" : "active")}</dd></div>
            </dl>
            {query.propertyId && isExpenseFundingAccount(account) ? <Link className="secondary-button" data-testid="payment-account-use"
              href={`/${locale}/app/properties/${query.propertyId}/expenses/new?fundingAccountId=${account.id}`}>{t("useForExpense")}</Link> : null}
          </li>;
        })}
      </ul>}
      {result.next ? <Link className="secondary-button" data-testid="payment-account-next" href={`/${locale}/app/finance/accounts?${next}`}>{t("next")}</Link> : null}
    </section>
  </AdminShell>;
}
