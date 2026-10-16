import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession, NotificationAccessError } from "@/platform/notifications/notification-service";
import { whatsappSourceSchema } from "@/platform/notifications/whatsapp";
import { whatsappPage } from "@/platform/notifications/whatsapp-service";
import { WhatsappComposer } from "@/platform/notifications/whatsapp-composer";

export const dynamic = "force-dynamic";

export default async function WhatsappPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const session = await auth();
  if (!session?.user?.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await notificationActorFromSession(session);
  const query = await searchParams;
  const parsed = whatsappSourceSchema.safeParse({ type: query.type, id: query.id });
  if (!actor || !parsed.success) notFound();
  let data;
  try { data = await whatsappPage(actor, parsed.data); } catch (error) { if (error instanceof NotificationAccessError) notFound(); throw error; }
  const t = await getTranslations("Whatsapp");
  return <AdminShell className="resource-page" testId="whatsapp-page">
    <ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<Link className="secondary-button" href={`/${locale}/app`}>{t("back")}</Link>} />
    <WhatsappComposer key={`${parsed.data.type}-${parsed.data.id}`} source={parsed.data} options={data.options} contact={data.contact} />
  </AdminShell>;
}
