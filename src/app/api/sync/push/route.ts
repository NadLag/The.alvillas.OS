import { NextResponse, type NextRequest } from "next/server";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { parseSyncPushInput, pushSyncOps } from "@/modules/reservations/application/sync-service";
import { auth } from "@/platform/auth/session";

export async function POST(request: NextRequest) {
  const session = await auth();
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload: unknown = await request.json().catch((): null => null);
  const parsed = parseSyncPushInput(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const result = await pushSyncOps(ctx, parsed.data, {
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  });

  return NextResponse.json(result);
}
