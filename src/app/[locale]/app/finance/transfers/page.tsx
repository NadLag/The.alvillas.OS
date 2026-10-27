import Link from "next/link";
import { notFound,redirect } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { listFinancialTransfers,getFinancialTransferEditor,FinancialTransferAccessError } from "@/modules/finance/application/financial-transfer-service";
import { FinancialTransferForm,FinancialTransferVoidForm } from "@/modules/finance/ui/financial-transfer-forms";
import { financialTransferKinds } from "@/modules/finance/domain/financial-transfer";

export const dynamic="force-dynamic";
export default async function FinancialTransfersPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{q?:string;after?:string;from?:string;to?:string;historyAfter?:string}>}){
  const {locale:value}=await params,locale=safeLocale(value);setRequestLocale(locale);
  const actor=await financeActorContextFromSession(await auth());if(!actor)redirect(`/${locale}/login`);
  const query=await searchParams,t=await getTranslations("FinancialTransfers");let history,editor;
  try{[history,editor]=await Promise.all([listFinancialTransfers(actor,{after:query.historyAfter}),getFinancialTransferEditor(actor,{query:query.q,after:query.after,from:query.from,to:query.to})])}
  catch(error){if(error instanceof FinancialTransferAccessError||error instanceof z.ZodError)notFound();throw error}
  const next=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value)next.set(key,value);if(history.next)next.set("historyAfter",history.next);
  return <AdminShell className="resource-page financial-transfer-page" testId="financial-transfer-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app/finance/accounts`}>{t("back")}</Link>}/>
    <FinancialTransferForm {...editor} canCreate={history.canCreate}/>
    <section aria-label={t("history")}><h2>{t("history")}</h2>
      {!history.rows.length?<p data-testid="transfer-empty">{t("empty")}</p>:<ul className="resource-list">{history.rows.map(row=>{
        const source=row.postings.find(line=>line.side==="CREDIT"),destination=row.postings.find(line=>line.side==="DEBIT");
        const kind=financialTransferKinds.find(kind=>kind===source?.bucket)??"TRANSFER";
        return <li className="resource-card" data-testid="transfer-row" key={row.id}><h3>{row.description}</h3><dl className="detail-grid">
          <div><dt>{t("amount")}</dt><dd className="money-value">{source?formatCurrencyAmount(locale,source.amount.toString(),source.currency):null}</dd></div>
          <div><dt>{t("from")}</dt><dd>{source?.ledgerAccount.name}</dd></div><div><dt>{t("to")}</dt><dd>{destination?.ledgerAccount.name}</dd></div>
          <div><dt>{t("kind")}</dt><dd>{t(`kinds.${kind}`)}</dd></div><div><dt>{t("status")}</dt><dd data-testid="transfer-status">{t(row.reversedByTransactions.length?"reversed":"posted")}</dd></div>
          <div><dt>{t("recordedUtc")}</dt><dd><time dateTime={row.occurredAt.toISOString()}>{row.occurredAt.toISOString()}</time></dd></div>
        </dl>{row.canVoid?<FinancialTransferVoidForm id={row.id}/>:null}</li>;
      })}</ul>}
      {history.next?<Link className="secondary-button" data-testid="transfer-history-next" href={`/${locale}/app/finance/transfers?${next}`}>{t("nextHistory")}</Link>:null}
    </section>
  </AdminShell>;
}
