import { randomUUID } from "node:crypto";
import { prisma } from "@/platform/db/client";
import { logger } from "@/platform/observability/logger";
import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { signatureMaximumEvidenceBytes } from "@/platform/providers/signature-contract";
import { DocumentRateLimitError } from "@/modules/documents/domain/document-command";
import { authenticateDocumensoWebhook, SignatureWebhookPayloadError } from "@/modules/documents/infrastructure/documenso-webhook";
import { receiveSignatureWebhook } from "@/modules/documents/application/document-signature-webhook";

export const runtime = "nodejs";
const reply = (received: boolean, status: number, headers: Record<string, string> = {}) => Response.json({ received }, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers } });
export async function POST(request: Request, context: { params: Promise<{ organizationId: string; providerScopeHash: string }> }) {
  const expected = process.env.DOCUMENSO_WEBHOOK_SECRET, secret = request.headers.get("x-documenso-secret"); if (!expected?.trim()) return reply(false, 503); if (!authenticateDocumensoWebhook(secret, expected)) return reply(false, 401);
  const declared = request.headers.get("content-length"); if (declared && /^\d+$/u.test(declared) && Number(declared) > signatureMaximumEvidenceBytes) return reply(false, 413);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return reply(false, 400);
  let bytes: Uint8Array; try { bytes = await readBoundedRequestBytes(request, signatureMaximumEvidenceBytes); } catch { return reply(false, 413); }
  const requestId = randomUUID();
  try { const scope = await context.params; await receiveSignatureWebhook(scope, secret, bytes, { db: prisma, requestId }); return reply(true, 200); }
  catch (error) { if (error instanceof SignatureWebhookPayloadError) return reply(false, 400); if (error instanceof DocumentRateLimitError) return reply(false, 429, { "Retry-After": String(Math.max(1, Math.ceil((error.resetAt.getTime() - Date.now()) / 1000))) }); logger.error("signature webhook persistence failed", { requestId }); return reply(false, 503); }
}
