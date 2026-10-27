import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatDate, formatDateTime, formatCurrencyAmount } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { getAccountingPeriod } from "@/modules/finance/application/accounting-period-service";
import { AccountingPeriodAccessError } from "@/modules/finance/domain/accounting-period";
import { AccountingPeriodForm, AccountingPeriodExpiry } from "@/modules/finance/ui/accounting-period-forms";

export const dynamic = "force-dynamic";
export default async function AccountingPeriodPage({ params, searchParams }: {
  params: Promise<{ locale: string; periodId: string }>; searchParams: Promise<{ after?: string }>;
}) {
  const { locale: raw, periodId } = await params, locale = safeLocale(raw); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const [query, t] = await Promise.all([searchParams, getTranslations("AccountingPeriods")]);
  let result;
  try { result = await getAccountingPeriod(actor, periodId, query.after ? Number(query.after) : undefined); }
  catch (error) { if (error instanceof AccountingPeriodAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const month = result.period.month.toISOString().slice(0, 7), timezone = result.period.timezone, version = result.latest?.version ?? 0;
  return <AdminShell className="resource-page financial-accounts-page accounting-periods-page" testId="accounting-period-detail">
    <ShellHeader eyebrow={t("eyebrow")} title={t("detailTitle", { month: formatDate(locale, result.period.month, { dateStyle: undefined, month: "long", year: "numeric", timeZone: "UTC" }) })}
      subtitle={timezone} actions={<Link className="secondary-button" href={`/${locale}/app/finance/periods`}>{t("back")}</Link>} />
    <p>{t("periodRange", { start: formatDateTime(locale, result.period.startsAt, { timeZone: timezone }), end: formatDateTime(locale, result.period.endsAt, { timeZone: timezone }) })}</p>
    <section aria-label={t("state")}><h2>{t("state")}</h2><p role="status" data-testid="accounting-period-state" data-state={result.state}>{t(`states.${result.state}`)}</p>
      {result.latest?.reopensUntil ? <p data-testid="accounting-period-deadline">{t(result.state === "REOPENED" ? "deadline" : "expired", { date: formatDateTime(locale, result.latest.reopensUntil, { timeZone: timezone }) })}</p> : null}
      {result.state === "REOPENED" && result.latest?.reopensUntil ? <AccountingPeriodExpiry deadline={result.latest.reopensUntil.toISOString()} serverNow={result.now.toISOString()} /> : null}
      <p>{t("closedPostingHint")}</p>
    </section>
    {result.policy && result.state === "CLOSED" && result.canReopen ? <AccountingPeriodForm key={`reopen-${version}`} kind="reopen" locale={locale} requestKey={crypto.randomUUID()} expectedVersion={version} periodId={result.period.id} maxSeconds={result.policy.value.max_reopen_seconds} /> : null}
    {result.latest?.kind === "REOPEN" && result.canClose && result.policy ? <AccountingPeriodForm key={`close-${version}`} kind="close" locale={locale} requestKey={crypto.randomUUID()} expectedVersion={version} month={month} /> : null}
    {!result.canClose ? <p>{t("readOnly")}</p> : null}
    <section aria-label={t("totals")}><h2>{t("totals")}</h2><p>{t("totalsHint")}</p>
      <p>{t("transactionCount", { count: result.snapshot.transactions })} · {t("postingCount", { count: result.snapshot.postings })}</p>
      <ul className="resource-list">{result.snapshot.currencies.map(row => <li className="resource-card" key={row.currency} data-testid="accounting-period-currency">
        <h3>{row.currency}</h3><dl className="accounting-period-summary"><div><dt>{t("debit")}</dt><dd>{formatCurrencyAmount(locale, row.debit, row.currency)}</dd></div>
          <div><dt>{t("credit")}</dt><dd>{formatCurrencyAmount(locale, row.credit, row.currency)}</dd></div></dl>
      </li>)}</ul>
    </section>
    <section aria-label={t("history")}><h2>{t("history")}</h2><ol className="resource-list">
      {result.rows.map(event => <li className="resource-card" key={event.id} data-testid="accounting-period-history">
        <h3>{t(`kinds.${event.kind as "CLOSE" | "REOPEN"}`)} · {t("version", { version: event.version })}</h3>
        <p>{event.reason}</p><p>{t("by", { name: event.creator.person.displayName })}</p><p>{t("policyVersion", { version: event.policy.version })}</p>
        <time dateTime={event.createdAt.toISOString()}>{formatDateTime(locale, event.createdAt, { timeZone: timezone })}</time>
      </li>)}
    </ol>{result.next ? <Link className="secondary-button" href={`/${locale}/app/finance/periods/${result.period.id}?after=${result.next}`} data-testid="accounting-period-history-next">{t("moreHistory")}</Link> : null}</section>
  </AdminShell>;
}
