import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { getTransactionGroup, TransactionGroupAccessError } from "@/modules/finance/application/transaction-group-service";
import { TransactionGroupMembershipForm } from "@/modules/finance/ui/transaction-group-forms";

export const dynamic = "force-dynamic";
export default async function TransactionGroupPage({ params, searchParams }: {
  params: Promise<{ locale: string; groupId: string }>;
  searchParams: Promise<{ q?: string; membersAfter?: string; historyAfter?: string; candidatesAfter?: string }>;
}) {
  const { locale: raw, groupId } = await params, locale = safeLocale(raw); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const query = await searchParams, t = await getTranslations("TransactionGroups");
  let result;
  try { result = await getTransactionGroup(actor, groupId, { query: query.q, membersAfter: query.membersAfter, historyAfter: query.historyAfter, candidatesAfter: query.candidatesAfter }); }
  catch (error) { if (error instanceof TransactionGroupAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const date = (value: Date) => formatDateTime(locale, value, { timeZone: "UTC" });
  const more = (key: "membersAfter" | "historyAfter" | "candidatesAfter", id: string) => {
    const values = new URLSearchParams(); for (const [name, value] of Object.entries(query)) if (value) values.set(name, value);
    values.set(key, id); return `/${locale}/app/finance/groups/${groupId}?${values}`;
  };
  return <AdminShell className="resource-page financial-accounts-page transaction-groups-page" testId="transaction-group-detail">
    <ShellHeader eyebrow={t("title")} title={result.group.name} subtitle={t("description")}
      actions={<Link className="secondary-button" href={`/${locale}/app/finance/groups`}>{t("back")}</Link>} />
    <p>{t("createdBy", { name: result.group.creator.person.displayName })} · <time dateTime={result.group.createdAt.toISOString()}>{date(result.group.createdAt)} {t("utc")}</time></p>
    <p>{result.group.reason}</p>
    <section aria-label={t("movements")}><h2>{t("movements")}</h2><p>{t("movementsHelp")}</p>
      {!result.movements.length ? <p data-testid="transaction-group-no-movements">{t("noMembers")}</p> : ["location", "ownership", "company"].map(kind => {
        const rows = result.movements.filter(row => (["ASSET_LOCATION", "ASSET"].includes(row.accountType) ? "location" :
          ["CLAIM_OWNERSHIP", "CLAIM", "LIABILITY"].includes(row.accountType) ? "ownership" : "company") === kind);
        return rows.length ? <div key={kind}><h3>{t(kind)}</h3><ul className="resource-list">{rows.map(row => <li key={`${row.accountId}:${row.currency}`} data-testid="transaction-group-movement">
          <span>{row.name}</span> <strong className="money">{formatCurrencyAmount(locale, row.amount, row.currency)}</strong>
        </li>)}</ul></div> : null;
      })}
    </section>
    <section aria-label={t("members")}><h2>{t("members")}</h2>
      {!result.members.rows.length ? <p data-testid="transaction-group-members-empty">{t("noMembers")}</p> : <ul className="resource-list">
        {result.members.rows.map(entry => <li className="resource-card" key={entry.id} data-testid="transaction-group-member">
          <h3>{entry.transaction.reference}</h3><p>{entry.transaction.description}</p>
          <p><time dateTime={entry.transaction.occurredAt.toISOString()}>{date(entry.transaction.occurredAt)} {t("utc")}</time></p>
          <details><summary>{t("postings")}</summary><ul className="resource-list">{entry.transaction.postings.map(posting => <li key={posting.id}>
            {posting.ledgerAccount.name} · {t(posting.side === "DEBIT" ? "debit" : "credit")} · <span className="money">{formatCurrencyAmount(locale, posting.amount.toString(), posting.currency)}</span>
          </li>)}</ul></details>
          {result.canConfigure ? <details><summary>{t("detach")}</summary><TransactionGroupMembershipForm groupId={groupId} kind="detach"
            transaction={{ id: entry.transactionId, reference: entry.transaction.reference, previousEntryId: entry.id }} /></details> : null}
        </li>)}
      </ul>}
      {result.members.next ? <Link className="secondary-button" href={more("membersAfter", result.members.next)} data-testid="transaction-group-more-members">{t("moreMembers")}</Link> : null}
    </section>
    {result.canConfigure ? <section aria-label={t("attach")}><h2>{t("attach")}</h2>
      <form className="resource-form" method="get" data-testid="transaction-group-candidate-search-form"><label className="field"><span>{t("searchTransactions")}</span>
        <input name="q" maxLength={120} defaultValue={query.q ?? ""} data-testid="transaction-group-candidate-search" /></label>
        <div className="form-actions"><button className="secondary-button" type="submit">{t("search")}</button></div>
      </form>
      {!result.candidates.rows.length ? <p>{t("noCandidates")}</p> : null}
      <TransactionGroupMembershipForm groupId={groupId} kind="attach" candidates={result.candidates.rows.map(row => ({ id: row.id, reference: row.reference, previousEntryId: row.groupEntries[0]?.id ?? null }))} />
      {result.candidates.next ? <Link className="secondary-button" href={more("candidatesAfter", result.candidates.next)} data-testid="transaction-group-more-candidates">{t("moreCandidates")}</Link> : null}
    </section> : null}
    <section aria-label={t("history")}><h2>{t("history")}</h2>
      {!result.history.rows.length ? <p>{t("noHistory")}</p> : <ol className="resource-list">{result.history.rows.map(entry => <li className="resource-card" key={entry.id} data-testid="transaction-group-history">
        <h3>{t(entry.action === "ATTACH" ? "attached" : "detached")} · {entry.transaction.reference}</h3>
        <p>{entry.creator.person.displayName} · <time dateTime={entry.createdAt.toISOString()}>{date(entry.createdAt)} {t("utc")}</time></p><p>{entry.reason}</p>
      </li>)}</ol>}
      {result.history.next ? <Link className="secondary-button" href={more("historyAfter", result.history.next)} data-testid="transaction-group-more-history">{t("moreHistory")}</Link> : null}
    </section>
  </AdminShell>;
}
