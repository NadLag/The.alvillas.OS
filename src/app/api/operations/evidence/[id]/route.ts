import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/session";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { downloadOperationEvidence } from "@/modules/reservations/application/operation-evidence";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await downloadOperationEvidence(ctx, (await params).id);
    return new Response(result.bytes, {
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 404 });
  }
}
