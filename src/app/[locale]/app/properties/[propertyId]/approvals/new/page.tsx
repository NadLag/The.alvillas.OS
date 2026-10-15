import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { getApprovalProperty } from "@/platform/approvals/approval-service";
import { ApprovalAccessError } from "@/platform/approvals/approval";
import { ApprovalForm } from "@/platform/approvals/approval-form";

export const dynamic = "force-dynamic";
export default async function RequestApprovalPage({ params }: { params: Promise<{ locale: string; propertyId: string }> }) {
  const input = await params; const locale = safeLocale(input.locale); setRequestLocale(locale);
  const actor = await notificationActorFromSession(await auth()); if (!actor) redirect(`/${locale}/login`);
  const t = await getTranslations("Approvals"); let property;
  try { property = await getApprovalProperty(actor, input.propertyId); } catch (error) { if (error instanceof ApprovalAccessError || error instanceof Error && error.name === "ZodError") notFound(); throw error; }
  return <AdminShell className="resource-page"><ShellHeader eyebrow={property.name} title={t("request")} subtitle={t("description")}
    actions={<Link className="secondary-button" href={`/${locale}/app/properties/${property.id}`}>{t("back")}</Link>} /><ApprovalForm propertyId={property.id} /></AdminShell>;
}
