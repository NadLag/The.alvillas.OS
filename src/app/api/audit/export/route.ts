import type { NextRequest } from "next/server";
import { auditActorContextFromSession } from "@/modules/audit/application/audit-access";
import {
  AuditAuthorizationError,
  exportAuditHistoryCsv,
  parseAuditFilters
} from "@/modules/audit/application/audit-service";
import { auth } from "@/platform/auth/session";

export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  const ctx = await auditActorContextFromSession(session);

  if (!ctx) {
    return new Response("Unauthorized", { status: 401 });
  }

  const filters = parseAuditFilters({
    action: request.nextUrl.searchParams.get("action") ?? "",
    resourceType: request.nextUrl.searchParams.get("resourceType") ?? "",
    actorId: request.nextUrl.searchParams.get("actorId") ?? "",
    resourceId: request.nextUrl.searchParams.get("resourceId") ?? "",
    propertyScopeId: request.nextUrl.searchParams.get("propertyScopeId") ?? "",
    from: request.nextUrl.searchParams.get("from") ?? "",
    to: request.nextUrl.searchParams.get("to") ?? ""
  });

  try {
    const csv = await exportAuditHistoryCsv(ctx, filters, {
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    });

    return new Response(csv, {
      headers: {
        "content-disposition": `attachment; filename="audit-history-${new Date().toISOString().slice(0, 10)}.csv"`,
        "content-type": "text/csv; charset=utf-8"
      }
    });
  } catch (error) {
    if (error instanceof AuditAuthorizationError) {
      return new Response("Forbidden", { status: 403 });
    }

    throw error;
  }
}
