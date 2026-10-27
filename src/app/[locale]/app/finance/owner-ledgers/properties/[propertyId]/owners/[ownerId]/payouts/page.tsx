import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount,formatDateTime } from "@/i18n/format";
import { ownerLedgerActor } from "@/modules/finance/ui/owner-ledger-access";
import { ownerLedgerPath } from "@/modules/finance/domain/owner-ledger";
import { getOwnerPayoutWorkspace } from "@/modules/finance/application/owner-payout-workspace-service";
import { OwnerPayoutAccessError } from "@/modules/finance/application/owner-payout-service";
import { OwnerPayoutDraftForm } from "@/modules/finance/ui/owner-payout-forms";

export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string;ownerId:string;propertyId:string}>;searchParams:Promise<{after?:string;fundingAfter?:string;fundingQuery?:string;fundingAccountId?:string;reservationId?:string;bookingQuery?:string}>}){
  const {locale:value,ownerId,propertyId}=await params,locale=safeLocale(value);setRequestLocale(locale);
  const actor=await ownerLedgerActor(locale),query=await searchParams,t=await getTranslations("OwnerPayouts");let editor;
  try{editor=await getOwnerPayoutWorkspace(actor,{ownerId,propertyId,...query});}
  catch(error){if(error instanceof OwnerPayoutAccessError||error instanceof z.ZodError)notFound();throw error;}
  const next=new URLSearchParams();for(const [key,value]of Object.entries(query))if(value)next.set(key,value);if(editor.next)next.set("after",editor.next);
  return <AdminShell className="resource-page owner-payout-page" testId="payout-workspace-page">
    <ShellHeader eyebrow={editor.property.name} title={t("title",{owner:editor.owner.name})} subtitle={t("description")}
      actions={<Link className="secondary-button" href={ownerLedgerPath(locale,ownerId,propertyId)}>{t("back")}</Link>}/>
    {editor.canCreate?<OwnerPayoutDraftForm editor={editor}/>:null}
    <section aria-label={t("history")}><h2>{t("history")}</h2>
      {!editor.rows.length?<p data-testid="payout-empty">{t("empty")}</p>:<ul className="resource-list">{editor.rows.map(row=><li className="resource-card" data-testid="payout-row" key={row.id}>
        <h3><Link href={`/${locale}/app/payouts/${row.id}`} prefetch={false}>{row.purpose}</Link></h3>
        <dl className="detail-grid"><div><dt>{t("amount")}</dt><dd className="money-value" dir="auto">{formatCurrencyAmount(locale,row.amount,row.currency)}</dd></div>
          <div><dt>{t("status")}</dt><dd>{t(`states.${row.state}`)}</dd></div><div><dt>{t("recipientMethod")}</dt><dd>{row.payoutMethodLabel}</dd></div>
          <div><dt>{t("createdAt")}</dt><dd><time dateTime={row.createdAt}>{formatDateTime(locale,new Date(row.createdAt),{timeZone:editor.property.timezone})}</time></dd></div></dl>
      </li>)}</ul>}
      {editor.next?<Link className="secondary-button" data-testid="payout-next" href={`?${next}`} prefetch={false}>{t("next")}</Link>:null}
    </section>
  </AdminShell>;
}
