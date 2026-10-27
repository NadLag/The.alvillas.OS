import Link from "next/link";
import { getTranslations,setRequestLocale } from "next-intl/server";
import { AdminShell,ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatCurrencyAmount,formatDateTime } from "@/i18n/format";
import { localClockLabel } from "@/platform/time/local-instant";
import { ownerPayoutWorkspacePath } from "@/modules/finance/domain/owner-payout";
import { ownerLedgerPath } from "@/modules/finance/domain/owner-ledger";
import { ownerPayoutPage } from "@/modules/finance/ui/owner-payout-page-access";
import { OwnerPayoutCommandForm,OwnerPayoutRefresh } from "@/modules/finance/ui/owner-payout-forms";

export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{locale:string;id:string}>}){
  const {locale:value,id}=await params,locale=safeLocale(value);setRequestLocale(locale);
  const [payout,t]=await Promise.all([ownerPayoutPage(locale,id),getTranslations("OwnerPayouts")]);
  const date=(value:string)=>formatDateTime(locale,new Date(value),{timeZone:payout.timezone});
  const earliest=Math.max(Date.parse(payout.now),payout.eligibleAt?Date.parse(payout.eligibleAt):0);
  const defaultSchedule=localClockLabel(new Date(Math.ceil(earliest/1000)*1000).toISOString(),payout.timezone);
  return <AdminShell className="resource-page owner-payout-page" testId="payout-detail-page">
    <ShellHeader eyebrow={payout.ownerName} title={payout.purpose} subtitle={payout.propertyName}
      actions={<Link className="secondary-button" href={payout.canViewWorkspace?ownerPayoutWorkspacePath(locale,payout.ownerId,payout.propertyId):`/${locale}/app`}>{t("back")}</Link>}/>
    <section className="notification-settings"><h2>{t("details")}</h2><p className="status-badge" data-testid="payout-state" role="status">{t(`states.${payout.state}`)}</p>
      <dl className="detail-grid"><div><dt>{t("amount")}</dt><dd className="money-value" dir="auto" data-testid="payout-total">{formatCurrencyAmount(locale,payout.amount,payout.currency)}</dd></div>
        <div><dt>{t("recipientMethod")}</dt><dd>{payout.payoutMethodLabel}</dd></div>
        {(["createdAt","expectedSettlementAt","eligibleAt","approvedAt","scheduledFor","paidAt"] as const).map(key=>payout[key]?<div key={key}><dt>{t(key)}</dt><dd><time dateTime={payout[key]}>{date(payout[key])}</time></dd></div>:null)}
        {payout.paymentReference?<div><dt>{t("paymentReference")}</dt><dd dir="auto" data-testid="payout-recorded-reference">{payout.paymentReference}</dd></div>:null}
      </dl><p>{t("timezone",{timezone:payout.timezone})}</p>
      {payout.failureReason?<p role="status" data-testid="payout-failure" dir="auto">{payout.failureReason}</p>:null}
      {payout.recipientChanged?<p role="alert">{t("recipientChanged")}</p>:null}
      {payout.canEdit?<OwnerPayoutCommandForm id={id} version={payout.version} command="submit"/>:null}
      {payout.state==="PENDING_APPROVAL"&&payout.approvalId?<Link className="primary-button" data-testid="payout-approval-link" href={`/${locale}/app/approvals/${payout.approvalId}`} prefetch={false}>{t("viewApproval")}</Link>:null}
      {payout.canSchedule?<OwnerPayoutCommandForm id={id} version={payout.version} command="schedule" defaultSchedule={defaultSchedule}/>:null}
      {payout.canPay?<OwnerPayoutCommandForm id={id} version={payout.version} command="pay"/>:payout.state==="SCHEDULED"?<><p>{t("scheduledGuidance")}</p><OwnerPayoutRefresh/></>:null}
      {payout.canViewLedger?<Link className="secondary-button" data-testid="payout-ledger-link" href={ownerLedgerPath(locale,payout.ownerId,payout.propertyId)}>{t("viewLedger")}</Link>:null}
      {payout.canReverse?<details><summary>{t("commands.reverse")}</summary><OwnerPayoutCommandForm id={id} version={payout.version} command="reverse"/></details>:null}
      {payout.canFail?<details><summary>{t("commands.fail")}</summary><OwnerPayoutCommandForm id={id} version={payout.version} command="fail"/></details>:null}
      {payout.canCancel?<details><summary>{t("commands.cancel")}</summary><OwnerPayoutCommandForm id={id} version={payout.version} command="cancel"/></details>:null}
    </section>
  </AdminShell>;
}
