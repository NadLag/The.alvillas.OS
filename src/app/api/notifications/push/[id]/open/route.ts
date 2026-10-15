import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { pushRecord } from "@/platform/notifications/push-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) return new Response(null, { status: 303, headers: { Location: "/en/login", "Cache-Control": "no-store" } });
    const data = await pushRecord(actor, (await params).id, "open");
    return new Response(null, { status: 303, headers: { Location: data.url, "Cache-Control": "no-store" } });
  } catch { return new Response(null, { status: 404 }); }
}
