import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatCurrency } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import type { getCommandFinance } from "../application/command-center-finance";

export async function CommandFinancePanel({ report, locale }: { report: Awaited<ReturnType<typeof getCommandFinance>>; locale: AppLocale }) {
  const t = await getTranslations("CommandFinance"), path = `/${locale}/app`;
  return <section className="detail-panel">
    <h2>{t("summary")}</h2>
    <dl className="detail-grid">{(["revenue", "expenses", "cash", "ownerPayable", "companyBalance"] as const).map(key =>
      <div key={key}><dt>{t(key)}</dt><dd className="money">{formatCurrency(locale, report[key])}</dd></div>)}</dl>
    <p className="field-hint">{t("basis")}</p>
    <nav className="form-actions" aria-label={t("summary")}>
      <Link href={path + "/finance/company-ledger"} className="secondary-button">{t("companyLedger")}</Link>
      <Link href={path + "/finance/owner-ledgers"} className="secondary-button">{t("ownerLedgers")}</Link>
    </nav>
  </section>;
}
