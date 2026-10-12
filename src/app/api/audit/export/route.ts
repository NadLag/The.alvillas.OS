import { NextResponse, type NextRequest } from "next/server";
import {
  AuditAuthorizationError,
  exportAuditRecords,
  parseAuditFilters
} from "@/modules/audit/application/audit-service";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { auth } from "@/platform/auth/session";

export const dynamic = "force-dynamic";

function filtersFromRequest(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  return parseAuditFilters({
    action: params.get("action") ?? undefined,
    resourceType: params.get("resourceType") ?? undefined,
    actorId: params.get("actorId") ?? undefined,
    requestId: params.get("requestId") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    limit: params.get("limit") ?? "200"
  });
}

export async function GET(request: NextRequest) {
  const ctx = await identityActorContextFromSession(await auth());

  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { csv } = await exportAuditRecords(ctx, filtersFromRequest(request), {
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    });

    return new NextResponse(csv, {
      headers: {
        "content-disposition": `attachment; filename="alvillas-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        "content-type": "text/csv; charset=utf-8"
      }
    });
  } catch (error) {
    if (error instanceof AuditAuthorizationError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ error: "Invalid audit export request" }, { status: 400 });
  }
}

