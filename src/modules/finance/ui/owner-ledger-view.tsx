import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrencyAmount,formatDateTime } from "@/i18n/format";
import { getOwnerLedger,OwnerLedgerAccessError,OwnerLedgerConfigurationError } from "../application/owner-ledger-service";
import { ownerLedgerBuckets,ownerLedgerPath } from "../domain/owner-ledger";
import { ownerLedgerActor } from "./owner-ledger-access";
import { OwnerLedgerFilters } from "./owner-ledger-filters";
import { ownerPayoutWorkspacePath } from "../domain/owner-payout";

export type OwnerLedgerSearch={fromOn?:string;toOn?:string;currency?:string;timezone?:string;after?:string};
export async function OwnerLedgerView({locale,ownerId,propertyId,query}:{locale:AppLocale;ownerId:string;propertyId?:string;query:OwnerLedgerSearch}){
  const actor=await ownerLedgerActor(locale),t=await getTranslations("OwnerLedger");let ledger;
  try{ledger=await getOwnerLedger(actor,{ownerId,propertyId,fromOn:query.fromOn,toOn:query.toOn,currency:query.currency,timezone:query.timezone,after:query.after})}
  catch(error){
    if(error instanceof OwnerLedgerAccessError||error instanceof z.ZodError)notFound();
    if(error instanceof OwnerLedgerConfigurationError)return <AdminShell className="resource-page owner-ledger-page"><h1>{t("title")}</h1><p role="status">{t("unavailable")}</p><Link className="secondary-button" href={`/${locale}/app/finance/owner-ledgers`}>{t("back")}</Link></AdminShell>;
    throw error;
  }
  const path=ownerLedgerPath(locale,ownerId,propertyId),money=(amount:string)=>formatCurrencyAmount(locale,amount,ledger.currency);
  const next=new URLSearchParams({fromOn:ledger.fromOn,toOn:ledger.toOn,currency:ledger.currency,timezone:ledger.timezone});if(ledger.next)next.set("after",ledger.next);
  const bucketName=(bucket:string|null)=>{const known=ownerLedgerBuckets.find(value=>value===bucket);return known?t(`buckets.${known}`):t("otherMovement")};
  return <AdminShell className="resource-page owner-ledger-page" testId="owner-ledger-page">
    <ShellHeader eyebrow={t("eyebrow")} title={ledger.owner.name} subtitle={ledger.property?.name??t("allProperties")} actions={<div className="form-actions">
      {ledger.property?<Link className="secondary-button" data-testid="owner-ledger-payouts" href={ownerPayoutWorkspacePath(locale,ownerId,ledger.property.id)}>{t("payouts")}</Link>:null}
      <Link className="secondary-button" href={`/${locale}/app/finance/owner-ledgers`}>{t("back")}</Link></div>}/>
    {ledger.owner.archived?<p className="status-badge">{t("archivedOwner")}</p>:null}
    <section className="owner-ledger-summary" aria-label={t("summary")}><h2>{t("closing")}</h2><p className="owner-ledger-closing money-value" data-testid="owner-ledger-closing" dir="auto">{money(ledger.closingBalance)}</p>
      <dl className="detail-grid"><div><dt>{t("opening")}</dt><dd data-testid="owner-ledger-opening" dir="auto">{money(ledger.openingBalance)}</dd></div>
        <div><dt>{t("credits")}</dt><dd data-testid="owner-ledger-credits" dir="auto">{money(ledger.periodCredits)}</dd></div><div><dt>{t("debits")}</dt><dd data-testid="owner-ledger-debits" dir="auto">{money(ledger.periodDebits)}</dd></div></dl>
      <p>{t("description")}</p>
    </section>
    <OwnerLedgerFilters key={[path,ledger.fromOn,ledger.toOn,ledger.currency,ledger.timezone].join(":")} currentPath={path} allPath={ledger.canViewAllProperties?ownerLedgerPath(locale,ownerId):undefined}
      properties={ledger.properties.map(property=>({path:ownerLedgerPath(locale,ownerId,property.id),name:property.name}))} fromOn={ledger.fromOn} toOn={ledger.toOn} currency={ledger.currency} currencies={ledger.currencies} timezone={ledger.timezone}/>
    <section aria-label={t("bucketTotals")}><h2>{t("bucketTotals")}</h2>{!ledger.bucketTotals.length?<p>{t("empty")}</p>:<ul className="owner-ledger-buckets">{ledger.bucketTotals.map(row=><li key={row.bucket??"other"}><span>{bucketName(row.bucket)}</span><strong className="money-value" dir="auto">{money(row.net)}</strong></li>)}</ul>}</section>
    <section aria-label={t("movements")}><h2>{t("movements")}</h2><p>{t("movementCount",{count:new Intl.NumberFormat(locale).format(BigInt(ledger.rowCount))})}</p>
      {!ledger.lines.length?<p data-testid="owner-ledger-empty">{t("empty")}</p>:<ol className="owner-ledger-lines">{ledger.lines.map(line=><li className="resource-card" data-testid="owner-ledger-line" key={line.id}>
        <h3>{line.description??bucketName(line.bucket)}</h3><dl className="detail-grid">
          <div><dt>{t("recordedAt")}</dt><dd><time dateTime={line.occurredAt}>{formatDateTime(locale,new Date(line.occurredAt),{timeZone:ledger.timezone})}</time></dd></div>
          <div><dt>{t("reference")}</dt><dd>{line.reference}</dd></div><div><dt>{t("movementType")}</dt><dd>{bucketName(line.bucket)}</dd></div>
          <div><dt>{t(line.side==="CREDIT"?"credits":"debits")}</dt><dd className="money-value" dir="auto">{money(line.amount)}</dd></div>
          <div><dt>{t("runningBalance")}</dt><dd className="money-value" dir="auto" data-testid="owner-ledger-running">{money(line.runningBalance)}</dd></div>
          {line.propertyName?<div><dt>{t("property")}</dt><dd>{line.propertyName}</dd></div>:null}{line.category?<div><dt>{t("category")}</dt><dd>{line.category}</dd></div>:null}
        </dl>
      </li>)}</ol>}
      {ledger.next?<Link className="secondary-button" data-testid="owner-ledger-next" href={path+"?"+next.toString()} prefetch={false}>{t("next")}</Link>:null}
    </section>
    <p className="field-hint">{t("snapshotAt",{date:formatDateTime(locale,new Date(ledger.snapshotAt),{timeZone:ledger.timezone})})} · {ledger.timezone}</p>
  </AdminShell>;
}
