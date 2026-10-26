import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { listTransactionGroups, TransactionGroupAccessError } from "@/modules/finance/application/transaction-group-service";
import { TransactionGroupForm } from "@/modules/finance/ui/transaction-group-forms";

export const dynamic = "force-dynamic";
export default async function TransactionGroupsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; after?: string }>;
}) {
  const { locale: raw } = await params, locale = safeLocale(raw); setRequestLocale(locale);
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const query = await searchParams, t = await getTranslations("TransactionGroups");
  let result;
  try { result = await listTransactionGroups(actor, { query: query.q, after: query.after }); }
  catch (error) { if (error instanceof TransactionGroupAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const next = new URLSearchParams({ ...(query.q ? { q: query.q } : {}), ...(result.next ? { after: result.next } : {}) });
  return <AdminShell className="resource-page financial-accounts-page transaction-groups-page" testId="transaction-groups-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")}
      actions={<Link className="secondary-button" href={`/${locale}/app/finance/accounts`}>{t("accounts")}</Link>} />
    <form className="resource-form" method="get"><label className="field"><span>{t("searchGroups")}</span>
      <input name="q" defaultValue={query.q ?? ""} maxLength={120} data-testid="transaction-group-search" /></label>
      <div className="form-actions"><button className="secondary-button" type="submit">{t("search")}</button></div>
    </form>
    {result.canConfigure ? <TransactionGroupForm locale={locale} /> : null}
    <section aria-label={t("groups")}><h2>{t("groups")}</h2>
      {!result.rows.length ? <p data-testid="transaction-groups-empty">{t("empty")}</p> : <ul className="resource-list">
        {result.rows.map(group => <li className="resource-card" key={group.id} data-testid="transaction-group-row">
          <h3><Link href={`/${locale}/app/finance/groups/${group.id}`}>{group.name}</Link></h3>
          <p>{t("memberCount", { count: group._count.entries })}</p>
        </li>)}
      </ul>}
      {result.next ? <Link className="secondary-button" href={`/${locale}/app/finance/groups?${next}`} data-testid="transaction-groups-next">{t("moreGroups")}</Link> : null}
    </section>
  </AdminShell>;
}
