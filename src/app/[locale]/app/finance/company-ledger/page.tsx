import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import { getCompanyLedger, CompanyLedgerAccessError, CompanyLedgerConfigurationError } from "@/modules/finance/application/company-ledger-service";
import { companyLedgerActor } from "@/modules/finance/ui/company-ledger-access";
import { CompanyLedgerFilters } from "@/modules/finance/ui/company-ledger-filters";

export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ fromOn?: string; toOn?: string; currency?: string; timezone?: string; after?: string }> }) {
  const { locale: value } = await params, locale = safeLocale(value);
  setRequestLocale(locale);
  const actor = await companyLedgerActor(locale), query = await searchParams, t = await getTranslations("CompanyLedger");
  let ledger;
  try { ledger = await getCompanyLedger(actor, query); }
  catch (error) {
    if (error instanceof CompanyLedgerAccessError || error instanceof z.ZodError) notFound();
    if (error instanceof CompanyLedgerConfigurationError) return <AdminShell className="resource-page"><h1>{t("title")}</h1><p role="status">{t("unavailable")}</p></AdminShell>;
    throw error;
  }
  const path = `/${locale}/app/finance/company-ledger`, money = (amount: string) => formatCurrencyAmount(locale, amount, ledger.currency);
  const next = new URLSearchParams({ fromOn: ledger.fromOn, toOn: ledger.toOn, currency: ledger.currency, timezone: ledger.timezone });
  if (ledger.next) next.set("after", ledger.next);
  return <AdminShell className="resource-page owner-ledger-page" testId="company-ledger-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>} />
    <section className="owner-ledger-summary" aria-label={t("summary")}><h2>{t("closing")}</h2><p className="owner-ledger-closing money-value" dir="auto" data-testid="company-ledger-closing">{money(ledger.closingBalance)}</p>
      <dl className="detail-grid">{(["openingBalance", "periodCredits", "periodDebits", "periodResult"] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd className="money-value" dir="auto" data-amount={ledger[key]} data-testid={`company-ledger-${key}`}>{money(ledger[key])}</dd></div>)}</dl>
    </section>
    <CompanyLedgerFilters key={[ledger.fromOn, ledger.toOn, ledger.currency, ledger.timezone].join(":")} path={path} fromOn={ledger.fromOn} toOn={ledger.toOn} currency={ledger.currency} currencies={ledger.currencies} timezone={ledger.timezone} />
    <section aria-label={t("accounts")}><h2>{t("accounts")}</h2>{!ledger.accounts.length ? <p>{t("empty")}</p> : <ul className="owner-ledger-buckets">{ledger.accounts.map(account => <li key={account.id}><span>{account.name}</span><strong className="money-value" dir="auto">{money(account.closingBalance)}</strong></li>)}</ul>}</section>
    <section aria-label={t("movements")}><h2>{t("movements")}</h2><p>{t("movementCount", { count: new Intl.NumberFormat(locale).format(BigInt(ledger.rowCount)) })}</p>
      {!ledger.lines.length ? <p data-testid="company-ledger-empty">{t("empty")}</p> : <ol className="owner-ledger-lines">{ledger.lines.map(line => <li className="resource-card" data-testid="company-ledger-line" key={line.id}><h3>{line.accountName}</h3><dl className="detail-grid">
        <div><dt>{t("recordedAt")}</dt><dd><time dateTime={line.occurredAt}>{formatDateTime(locale, new Date(line.occurredAt), { timeZone: ledger.timezone })}</time></dd></div>
        <div><dt>{t("reference")}</dt><dd>{line.reference}</dd></div><div><dt>{t(line.side === "CREDIT" ? "periodCredits" : "periodDebits")}</dt><dd className="money-value" dir="auto">{money(line.amount)}</dd></div>
        <div><dt>{t("runningBalance")}</dt><dd className="money-value" dir="auto" data-testid="company-ledger-running">{money(line.runningBalance)}</dd></div>
      </dl></li>)}</ol>}
      {ledger.next ? <Link className="secondary-button" data-testid="company-ledger-next" href={path + "?" + next.toString()} prefetch={false}>{t("next")}</Link> : null}
    </section>
    <p className="field-hint">{t("snapshotAt", { date: formatDateTime(locale, new Date(ledger.snapshotAt), { timeZone: ledger.timezone }) })} · {ledger.timezone}</p>
  </AdminShell>;
}
