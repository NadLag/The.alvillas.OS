import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { safeLocale } from "@/i18n/routing";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { listOwnerLedgerChoices,OwnerLedgerAccessError } from "@/modules/finance/application/owner-ledger-service";
import { ownerLedgerPath } from "@/modules/finance/domain/owner-ledger";
import { ownerLedgerActor } from "@/modules/finance/ui/owner-ledger-access";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{q?:string;after?:string}>}){
  const {locale:value}=await params,locale=safeLocale(value);setRequestLocale(locale);const actor=await ownerLedgerActor(locale),query=await searchParams,t=await getTranslations("OwnerLedger");let result;
  try{result=await listOwnerLedgerChoices(actor,{query:query.q,after:query.after})}catch(error){if(error instanceof OwnerLedgerAccessError||error instanceof z.ZodError)notFound();throw error}
  const next=new URLSearchParams();if(query.q)next.set("q",query.q);if(result.next)next.set("after",result.next);
  return <AdminShell className="resource-page owner-ledger-page" testId="owner-ledger-index"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("indexDescription")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("backWorkspace")}</Link>}/>
    <form className="resource-form" method="get"><label className="field"><span>{t("search")}</span><input name="q" data-testid="owner-ledger-search" type="search" defaultValue={query.q} maxLength={120}/></label><div className="form-actions"><button className="primary-button" type="submit">{t("searchAction")}</button></div></form>
    {!result.owners.length?<p data-testid="owner-ledger-none">{t("noLedgers")}</p>:<ul className="resource-list">{result.owners.map(owner=><li className="resource-card" key={owner.id}><h2>{owner.name}</h2>{owner.propertyName?<p>{owner.propertyName}</p>:null}
      <Link className="secondary-button" data-testid="owner-ledger-open" href={ownerLedgerPath(locale,owner.id,owner.propertyId)} aria-label={t("viewOwner",{owner:owner.name})} prefetch={false}>{t("viewLedger")}</Link></li>)}</ul>}
    {result.next?<Link className="secondary-button" href={`/${locale}/app/finance/owner-ledgers?${next}`} data-testid="owner-ledger-owners-next" prefetch={false}>{t("next")}</Link>:null}
  </AdminShell>;
}
