import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { captureException } from "@/platform/observability/sentry";
import type { DocumentActorContext } from "../application/document-archive";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError, DocumentStorageError } from "../domain/document-command";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Origin" };
const failure = (error: string, status: number) => NextResponse.json({ error }, { status, headers });
export async function documentHttp<T>(request: NextRequest, work: (actor: DocumentActorContext, input: unknown, requestId: string) => Promise<T>,
  options: { binary?: boolean; respond?: (value: T) => Response } = {}) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await accountActorContextFromSession(await auth()); if (!actor) return failure("unauthorized",401);
    const scope = request.headers.get("x-alvillas-document-scope");
    if (scope !== null && scope !== actor.organizationId + "." + actor.actorId) return failure("forbidden",403);
    if (!isSameOriginContentType(request, options.binary ? "application/octet-stream" : "application/json")) return failure("forbidden",403);
    if (!options.binary && request.nextUrl.search) return failure("validation",400);
    let input: unknown;
    if (!options.binary) { try { input = await readBoundedJsonRequest(request,16384); } catch { return failure("validation",400); } }
    const value = await work(actor,input,requestId), response = options.respond ? options.respond(value) : NextResponse.json(value);
    for (const [key,value] of Object.entries(headers)) response.headers.set(key,value); return response;
  } catch (error) {
    if (error instanceof DocumentAccessError) return failure("forbidden",403);
    if (error instanceof ZodError) return failure("validation",400);
    if (error instanceof DocumentConfigurationError) return failure("configuration_unavailable",409);
    if (error instanceof DocumentConflictError) return failure("conflict",409);
    if (error instanceof DocumentStorageError) return failure("storage_unavailable",503);
    try { await captureException(new Error("Document archive request failed"), { source: "api", requestId, tags: { feature: "F-DOC-01" } }); } catch { /* Keep the private response when telemetry is unavailable. */ }
    return failure("unavailable",503);
  }
}
