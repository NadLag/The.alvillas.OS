import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/platform/auth/session";
import { identityActorContextFromSession, IdentityAuthorizationError } from "@/modules/identity/application/identity-access";
import { ownFieldWallet, TeamNotFoundError } from "@/modules/identity/application/team-service";
import { fieldWalletQuerySchema } from "@/modules/identity/domain/field-wallet";
import { captureException } from "@/platform/observability/sentry";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: NextRequest) {
  const session = await auth(), ctx = await identityActorContextFromSession(session);
  if (!ctx || session?.user?.securitySetupRequired) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const values = Object.fromEntries(request.nextUrl.searchParams), parsed = fieldWalletQuerySchema.safeParse(values);
  if (!parsed.success) return NextResponse.json({ error: "validation" }, { status: 400, headers });
  try { return NextResponse.json(await ownFieldWallet(ctx, parsed.data, { requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() }), { headers }); }
  catch (error) {
    if (error instanceof IdentityAuthorizationError) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
    if (error instanceof TeamNotFoundError) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
    void captureException(error, { source: "next", organizationId: ctx.organizationId, tags: { operation: "field-wallet" } });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
