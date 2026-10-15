import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { pushRecord } from "@/platform/notifications/push-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) return new Response(null, { status: 401 });
    const data = await pushRecord(actor, (await params).id, "display");
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch { return new Response(null, { status: 404 }); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (request.headers.get("sec-fetch-site") !== "same-origin" || request.headers.get("x-alvillas-push-receipt") !== "1") return new Response(null, { status: 403 });
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) return new Response(null, { status: 401 });
    await pushRecord(actor, (await params).id, "displayed");
    return new Response(null, { status: 204 });
  } catch { return new Response(null, { status: 404 }); }
}
