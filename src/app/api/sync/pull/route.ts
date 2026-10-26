import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/platform/auth/session";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { pullFieldWork } from "@/modules/reservations/application/field-pull-service";
import { FieldPullError } from "@/modules/reservations/application/field-pull-cursor";
import { fieldPullInputSchema } from "@/modules/reservations/domain/field-pull";
import { captureException } from "@/platform/observability/sentry";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const ctx = await reservationActorContextFromSession(await auth());
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const query = request.nextUrl.searchParams, text = query.get("known_tasks") ?? "";
  if (text.length > 6000 || !["only_known", "include_device_policy", "include_linen", "include_inventory", "include_issue_capture", "include_cash"].every(key => [null, "0", "1"].includes(query.get(key)))) return NextResponse.json({ error: "validation" }, { status: 400, headers });
  const parsed = fieldPullInputSchema.safeParse({ organization_id: query.get("organization_id"), actor_user_id: query.get("actor_user_id"),
    mode: query.get("mode") ?? undefined, property_id: query.get("property_id") ?? undefined, cursor: query.get("cursor") ?? undefined,
    known_tasks: text ? text.split(",").map(entry => { const parts = entry.split("."); return { id: parts.length === 2 ? parts[0] : undefined, revision: parts[1] === "-" ? null : parts[1] }; }) : [],
    only_known: query.get("only_known") === "1", include_device_policy: query.get("include_device_policy") === "1", include_linen: query.get("include_linen") === "1", include_inventory: query.get("include_inventory") === "1", include_issue_capture: query.get("include_issue_capture") === "1", include_cash: query.get("include_cash") === "1" });
  if (!parsed.success) return NextResponse.json({ error: "validation", fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400, headers });
  try { return NextResponse.json(await pullFieldWork(ctx, parsed.data), { headers }); }
  catch (error) {
    if (error instanceof FieldPullError) return NextResponse.json({ error: error.code }, { status: error.code === "forbidden" ? 403 : error.code === "reset_required" ? 409 : 400, headers });
    void captureException(error, { source: "next", organizationId: ctx.organizationId, tags: { operation: "field-pull" } });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
