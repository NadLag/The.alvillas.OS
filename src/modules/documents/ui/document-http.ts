import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { captureException } from "@/platform/observability/sentry";
import type { DocumentActorContext } from "../application/document-archive";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError, DocumentStorageError,DocumentRateLimitError } from "../domain/document-command";
import { TemplateDefinitionError } from "../domain/document-template";
import { DocumentPdfConfigurationError } from "../domain/document-pdf";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Origin" };
const failure = (error: string, status: number) => NextResponse.json({ error }, { status, headers });
export async function documentHttp<T>(request: NextRequest, work: (actor: DocumentActorContext, input: unknown, requestId: string) => Promise<T>,
  options: { binary?: boolean; jsonBytes?:number; feature?:"F-DOC-01"|"F-DOC-02"|"F-DOC-03"; respond?: (value: T) => Response } = {}) {
  const requestId = crypto.randomUUID();
  let organizationId:string|undefined;
  try {
    const actor = await accountActorContextFromSession(await auth()); if (!actor) return failure("unauthorized",401);
    organizationId=actor.organizationId;
    const scope = request.headers.get("x-alvillas-document-scope");
    if (scope !== null && scope !== actor.organizationId + "." + actor.actorId) return failure("forbidden",403);
    if (!isSameOriginContentType(request, options.binary ? "application/octet-stream" : "application/json")) return failure("forbidden",403);
    if (!options.binary && request.nextUrl.search) return failure("validation",400);
    let input: unknown;
    if (!options.binary) { try { input = await readBoundedJsonRequest(request,options.jsonBytes??16384); } catch { return failure("validation",400); } }
    const value = await work(actor,input,requestId), response = options.respond ? options.respond(value) : NextResponse.json(value);
    for (const [key,value] of Object.entries(headers)) response.headers.set(key,value); return response;
  } catch (error) {
    if (error instanceof DocumentAccessError) return failure("forbidden",403);
    if (error instanceof ZodError || error instanceof TemplateDefinitionError) return failure("validation",400);
    if (error instanceof DocumentConfigurationError || error instanceof DocumentPdfConfigurationError) return failure("configuration_unavailable",409);
    if (error instanceof DocumentConflictError) return failure("conflict",409);
    if (error instanceof DocumentStorageError) return failure("storage_unavailable",503);
    if(error instanceof DocumentRateLimitError){const response=failure("rate_limited",429);response.headers.set("Retry-After",String(Math.max(1,Math.ceil((error.resetAt.getTime()-Date.now())/1000))));return response;}
    try { await captureException(new Error("Document archive request failed"), { source: "api", requestId, organizationId, tags: { feature: options.feature??"F-DOC-01" } }); } catch { /* Keep the private response when telemetry is unavailable. */ }
    return failure("unavailable",503);
  }
}
