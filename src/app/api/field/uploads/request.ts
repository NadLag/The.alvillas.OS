import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { reservationActorContextFromSession, type ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { ReservationAuthorizationError, ReservationConflictError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import { FieldUploadUnavailableError } from "@/modules/reservations/application/field-upload-service";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
type Handler = (ctx: ReservationActorContext, value: unknown, meta: { requestId: string; ipAddress: string | null }) => Promise<unknown>;
export async function fieldUploadRequest(request: NextRequest, action: Handler, options: {
  contentType: string; read: (request: NextRequest) => Promise<unknown>;
} = { contentType: "application/json", read: request => readBoundedJsonRequest(request, 65536) }) {
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  // Match the existing private notification endpoint: Next can normalize the
  // internal URL hostname, while Host retains the browser's requested authority.
  const url = new URL(request.url), expectedOrigin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (request.headers.get("origin") !== expectedOrigin || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== options.contentType)
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  let value: unknown;
  try { value = await options.read(request); }
  catch { return NextResponse.json({ error: "validation" }, { status: 400, headers }); }
  try {
    const result = await action(ctx, value, { requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null });
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: "validation" }, { status: 400, headers });
    if (error instanceof ReservationAuthorizationError) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
    if (error instanceof ReservationNotFoundError) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
    if (error instanceof ReservationConflictError) return NextResponse.json({ error: error.message }, { status: 409, headers });
    if (error instanceof FieldUploadUnavailableError) return NextResponse.json({ error: "operation_storage_unavailable" }, { status: 503, headers });
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503, headers });
  }
}
