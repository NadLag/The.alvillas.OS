import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { getApproval } from "@/platform/approvals/approval-service";
import { ApprovalAccessError } from "@/platform/approvals/approval";
import { ApprovalForm } from "@/platform/approvals/approval-form";

export const dynamic = "force-dynamic";
export default async function ApprovalPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ stage?: string; afterStage?: string }> }) {
  const input = await params; const locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await notificationActorFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const t = await getTranslations("Approvals");
  const query = await searchParams; let approval;
  try { approval = await getApproval(actor, input.id, { stageId: query.stage, afterStageId: query.afterStage }); } catch (error) { if (error instanceof ApprovalAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page" testId="approval-page"><ShellHeader eyebrow={approval.propertyName ?? t("companySource")} title={t("title")} subtitle={t("next")}
    actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>} /><ApprovalForm key={approval.stageId} approval={approval} />
    {approval.history.length ? <section className="notification-settings" aria-label={t("reviewHistory")}><h2>{t("reviewHistory")}</h2>
      <ol className="resource-list">{approval.history.map(stage => <li className="resource-card" key={stage.id}>
        <p dir="auto">{stage.note}</p><p>{t(`states.${stage.state}`)}</p><Link className="secondary-button" data-testid="approval-stage-open"
          href={`/${locale}/app/approvals/${approval.id}?stage=${stage.id}`} prefetch={false}>{t("openReview")}</Link>
      </li>)}</ol>{approval.historyNext ? <Link className="secondary-button" href={`/${locale}/app/approvals/${approval.id}?afterStage=${approval.historyNext}`} prefetch={false}>{t("moreReviews")}</Link> : null}
    </section> : null}
  </AdminShell>;
}
