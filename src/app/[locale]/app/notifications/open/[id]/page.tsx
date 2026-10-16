import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession, NotificationAccessError, openNotification } from "@/platform/notifications/notification-service";

export const dynamic = "force-dynamic";
export default async function OpenNotification({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: value, id } = await params; const locale = safeLocale(value);
  const actor = await notificationActorFromSession(await auth());
  if (!actor) redirect(`/${locale}/login`);
  if (!z.uuid().safeParse(id).success) notFound();
  let destination: string;
  try { destination = await openNotification(actor, id, locale); }
  catch (error) { if (error instanceof NotificationAccessError) notFound(); throw error; }
  redirect(destination);
}
