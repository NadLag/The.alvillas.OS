import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { EmptyState, OwnerShell, ShellHeader } from "@/design-system/shells";
import { formatCurrencyAmount } from "@/i18n/format";
import { safeLocale } from "@/i18n/routing";
import { ApprovalForm } from "@/platform/approvals/approval-form";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { ownerApprovalDecisionAction } from "@/modules/owner-portal/application/owner-approval-actions";
import { loadOwnerApprovals, ownerApprovalSelection } from "@/modules/owner-portal/application/owner-approvals";
import { OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";

export default async function OwnerApprovalsPage({ params, searchParams }: {
  params: Promise<{ locale: string; propertyId: string }>; searchParams: Promise<{ approval?: string; stage?: string; after?: string }>;
}) {
  const [{ locale: requested, propertyId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const locale = safeLocale(requested);
  setRequestLocale(locale);
  if (!session) redirect(`/${locale}/login`);
  const [owner, actor, t] = await Promise.all([ownerPortalActorContextFromSession(session),
    notificationActorFromSession(session), getTranslations("OwnerPortal.approvals")]);
  const detail = query.approval || query.stage ? ownerApprovalSelection.safeParse({ id: query.approval, stageId: query.stage }) : undefined;
  const after = z.uuid().optional().safeParse(query.after);
  if (!owner || !actor || !after.success || detail?.success === false) notFound();
  const value = await loadOwnerApprovals(owner, actor, propertyId, detail?.data, after.data).catch((error: unknown) => {
    if (error instanceof OwnerPortalNotFoundError) notFound();
    throw error;
  });
  const portal = `/${locale}/app/owner-portal/properties/${propertyId}`, path = portal + "/approvals";
  const selected = detail ? value.items[0] : null;
  return <OwnerShell className="resource-page" testId="owner-approvals">
    <ShellHeader title={t("title")} eyebrow={value.property} actions={<Link className="secondary-button" href={selected ? path : portal}>{t("back")}</Link>} />
    {selected ? <ApprovalForm approval={{ ...selected.approval, title: t("sources." + selected.source), details: t("review") }}
      decisionAction={ownerApprovalDecisionAction.bind(null, propertyId)} decisionHref={path} />
      : value.items.length ? <ul className="resource-list">{value.items.map(row => <li key={row.stageId}>
        <Link className="resource-row" href={path + "?approval=" + row.approvalId + "&stage=" + row.stageId}>
          <span>{t("sources." + row.source)}</span><strong className="money">{formatCurrencyAmount(locale, row.amount, row.currency)}</strong>
        </Link>
      </li>)}</ul> : <EmptyState tone="motif">{t("empty")}</EmptyState>}
    {value.next ? <Link className="secondary-button" href={path + "?after=" + value.next}>{t("next")}</Link> : null}
  </OwnerShell>;
}
