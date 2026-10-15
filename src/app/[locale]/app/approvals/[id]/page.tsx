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
export default async function ApprovalPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const input = await params; const locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await notificationActorFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const t = await getTranslations("Approvals");
  let approval;
  try { approval = await getApproval(actor, input.id); } catch (error) { if (error instanceof ApprovalAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page" testId="approval-page"><ShellHeader eyebrow={approval.propertyName} title={t("title")} subtitle={t("next")}
    actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>} /><ApprovalForm approval={approval} /></AdminShell>;
}
