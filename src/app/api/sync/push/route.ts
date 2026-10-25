import { NextResponse, type NextRequest } from "next/server";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { parseSyncPushInput, pushSyncOps } from "@/modules/reservations/application/sync-service";
import { auth } from "@/platform/auth/session";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function POST(request: NextRequest) {
  const session = await auth();
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  }

  const url = new URL(request.url), expectedOrigin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (request.headers.get("origin") !== expectedOrigin || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  const payload: unknown = await readBoundedJsonRequest(request, 262144).catch((): null => null);
  const parsed = parseSyncPushInput(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400, headers }
    );
  }

  const result = await pushSyncOps(ctx, parsed.data, {
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  });

  return NextResponse.json(result, { headers });
}
