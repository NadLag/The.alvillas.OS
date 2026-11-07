import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { DocumensoSignatureProvider } from "@/platform/providers/real";

/** Owned real HTTP protocol; no external account, retry, or production TLS bypass. */
export async function ownedSignatureProvider(options: { port?: number; publicOrigin?: string } = {}) {
  type Lifecycle = { status?: "DRAFT" | "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED"; readStatus?: "NOT_OPENED" | "OPENED"; signingStatus?: "NOT_SIGNED" | "SIGNED" | "REJECTED"; signedAt?: string | null; expiresAt?: string | null; completedAt?: string | null };
  const calls: Array<{ method: string; path: string }> = [], token = "owned-private-provider-capability", scopeEnvelopeId = "owned_scope", scopeReference = "owned-existing-account-scope", teamId = randomInt(1, 2147483646);
  const state = { fault: "none" as "none" | "lost-create" | "wrong-team" | "wrong-pdf" | "substituted-recipient" | "fail-read" | "lost-send" | "send-no-effect" | "fail-sent-read", afterCreate: null as (() => Promise<void>) | null, afterDistribute: null as (() => Promise<void>) | null, lifecycle: {} as Lifecycle, recipientLifecycle: {} as Record<number, Lifecycle> };
  let origin = "", stored: { id: string; createdAt: string; sent: boolean; bytes: Uint8Array; name: string; payload: { externalId: string; title: string; meta: Record<string, unknown>; recipients: Array<{ name: string; email: string; role: string; signingOrder: number; fields: Array<Record<string, unknown>> }> } } | null = null;
  const server = createServer((request, response) => { void (async () => {
    const path = request.url ?? "", method = request.method ?? ""; calls.push({ path, method });
    if (request.headers.authorization !== "owned-signature-test-token") { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    if (path === "/api/v2/envelope/create" && method === "POST") {
      const chunks: Uint8Array[] = []; for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const form = await new Request(origin + path, { method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body: new Uint8Array(Buffer.concat(chunks)) }).formData(), file = form.get("files"), payload = form.get("payload");
      if (!(file instanceof File) || typeof payload !== "string") { response.writeHead(400).end(); return; }
      stored = { id: "owned_" + randomUUID().replaceAll("-", ""), createdAt: new Date().toISOString(), sent: false, bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, payload: JSON.parse(payload) as NonNullable<typeof stored>["payload"] };
      if (state.afterCreate) await state.afterCreate();
      if (state.fault === "lost-create") { response.destroy(); return; }
      response.end(JSON.stringify({ id: stored.id, token })); return;
    }
    if (path === "/api/v2/envelope/" + scopeEnvelopeId) {
      response.end(JSON.stringify({ id: scopeEnvelopeId, type: "DOCUMENT", source: "DOCUMENT", visibility: "ADMIN", externalId: scopeReference, title: "Owned existing account scope", status: "DRAFT", teamId: state.fault === "wrong-team" ? teamId + 1 : teamId,
        documentMeta: { language: "fr", signingOrder: "SEQUENTIAL", distributionMethod: "NONE", allowDictateNextSigner: false, typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: false, envelopeExpirationPeriod: null, emailSettings: null },
        recipients: [], envelopeItems: [{ id: "scope_item", envelopeId: scopeEnvelopeId, title: "owned-scope.pdf" }], fields: [] })); return;
    }
    if (!stored) { response.writeHead(404).end("{}"); return; }
    if (path === "/api/v2/envelope/distribute" && method === "POST") {
      const chunks: Uint8Array[] = []; for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk); const raw: unknown = JSON.parse(Buffer.concat(chunks).toString()), input = z.object({ envelopeId: z.string(), meta: z.object({ distributionMethod: z.literal("EMAIL") }).strict() }).strict().parse(raw);
      if (input.envelopeId !== stored.id || JSON.stringify(input.meta) !== JSON.stringify({ distributionMethod: "EMAIL" })) { response.writeHead(400).end("{}"); return; }
      if (state.fault === "send-no-effect") { response.writeHead(503).end(JSON.stringify({ private: token })); return; }
      stored.sent = true; if (state.afterDistribute) await state.afterDistribute(); if (state.fault === "lost-send") { response.destroy(); return; }
      response.end(JSON.stringify({ success: true, id: stored.id, recipients: stored.payload.recipients.map((_, index) => ({ id: index + 1, token })) })); return;
    }
    if (path === "/api/v2/envelope/item/owned_item/download?version=original") {
      response.setHeader("content-type", "application/pdf"); const bytes = new Uint8Array(stored.bytes); if (state.fault === "wrong-pdf") bytes[20] ^= 1; response.end(bytes); return;
    }
    if (path === "/api/v2/envelope/" + stored.id) {
      if (state.fault === "fail-read" || state.fault === "fail-sent-read" && stored.sent) { response.writeHead(503).end(JSON.stringify({ private: token })); return; }
      let nextField = 0; const { payload, id } = stored;
      response.end(JSON.stringify({ id, createdAt: stored.createdAt, type: "DOCUMENT", source: "DOCUMENT", visibility: "ADMIN", externalId: payload.externalId, title: payload.title, status: state.lifecycle.status ?? (stored.sent ? "PENDING" : "DRAFT"), completedAt: state.lifecycle.completedAt ?? null, teamId, documentMeta: { ...payload.meta, distributionMethod: stored.sent ? "EMAIL" : "NONE" },
        recipients: payload.recipients.map((recipient, index) => { const lifecycle = { ...state.lifecycle, ...state.recipientLifecycle[index + 1] }; return { id: index + 1, envelopeId: id, name: recipient.name, email: state.fault === "substituted-recipient" ? "substituted@example.test" : recipient.email,
          role: recipient.role, signingOrder: recipient.signingOrder, readStatus: lifecycle.readStatus ?? "NOT_OPENED", signingStatus: lifecycle.signingStatus ?? "NOT_SIGNED", sendStatus: stored!.sent ? "SENT" : "NOT_SENT", signedAt: lifecycle.signedAt ?? null, expiresAt: lifecycle.expiresAt ?? null, token }; }),
        envelopeItems: [{ id: "owned_item", envelopeId: id, title: stored.name }], fields: payload.recipients.flatMap((recipient, index) => recipient.fields.map(field => ({ ...field, id: ++nextField, recipientId: index + 1, envelopeItemId: "owned_item", positionX: String(field.positionX), positionY: String(field.positionY), width: String(field.width), height: String(field.height) }))) })); return;
    }
    response.writeHead(404).end("{}");
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned provider HTTP address required"); const ownedOrigin = "http://127.0.0.1:" + address.port; origin = options.publicOrigin ?? ownedOrigin;
  const signatureFetch: typeof fetch = (input, init) => { if (options.publicOrigin && (typeof input === "string" || input instanceof URL)) { const target = new URL(input); if (target.origin === origin) return fetch(ownedOrigin + target.pathname + target.search, init); } return fetch(input, init); };
  const provider = new DocumensoSignatureProvider({ NODE_ENV: "test", DOCUMENSO_URL: origin, DOCUMENSO_API_TOKEN: "owned-signature-test-token" }, undefined, signatureFetch);
  return { origin, provider, calls, state, scopeEnvelopeId, scopeReference, teamId, token, get requestId() { return stored?.id ?? null; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
