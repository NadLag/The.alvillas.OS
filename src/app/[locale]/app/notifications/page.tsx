import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { NotificationSettings } from "@/platform/notifications/notification-settings";
import { NotificationRoutingSettings } from "@/platform/notifications/notification-routing-settings";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { authorize } from "@/platform/authz/authorize";
import { DigestSettings } from "@/platform/notifications/digest-settings";
import { PushSettings } from "@/platform/notifications/push-settings";

export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const session = await auth();
  if (!session?.user?.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const t = await getTranslations("Notifications.settings");
  const actor = await notificationActorFromSession(session);
  const canConfigure = actor && authorize(actor.authContext, "configure", { type: "config_rule", organizationId: actor.organizationId });
  return <AdminShell className="resource-page" testId="notification-settings-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")}
      actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>} />
    <NotificationSettings />
    <DigestSettings />
    <PushSettings />
    {canConfigure ? <NotificationRoutingSettings /> : null}
  </AdminShell>;
}
