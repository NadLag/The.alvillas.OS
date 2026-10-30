import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "@/modules/finance/application/employee-compensation-service";
import { EmployeeCompensationBasisError } from "@/modules/finance/domain/employee-compensation";
import { previewEmployeeCompensationRequest } from "@/modules/finance/application/employee-compensation-preview-request";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { captureException } from "@/platform/observability/sentry";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Origin" };
export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth());
    if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
    if (!isSameOriginContentType(request, "application/json")) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
    let input: unknown;
    try { input = await readBoundedJsonRequest(request, 65536); }
    catch { return NextResponse.json({ error: "validation" }, { status: 400, headers }); }
    return NextResponse.json(await previewEmployeeCompensationRequest(actor, input, requestId), { headers });
  } catch (error) {
    if (error instanceof ZodError || error instanceof EmployeeCompensationBasisError)
      return NextResponse.json({ error: "validation" }, { status: 400, headers });
    if (error instanceof EmployeeCompensationAccessError) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
    if (error instanceof EmployeeCompensationSourceUnavailableError) return NextResponse.json({ error: "source_unavailable" }, { status: 409, headers });
    await captureException(error, { source: "api", requestId, tags: { feature: "employee-compensation-preview" } });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
