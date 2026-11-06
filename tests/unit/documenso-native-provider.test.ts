import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createElement } from "react";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumensoSignatureProvider } from "@/platform/providers/real";
import { FakeSignatureProvider } from "@/platform/providers/fakes";
import { signatureMaximumEvidenceBytes, type SignatureRequestInput } from "@/platform/providers/signature-request";

let server: Server, origin: string, pdf: Buffer, calls: Array<{ method: string; path: string }>, stored: { payload: Record<string, unknown>; bytes: Buffer; fileName: string; sent: boolean } | null,
  fault: "none" | "lost-create" | "lost-send" | "wrong-reference" | "foreign-parent" | "public" | "oversized" | "chunked-oversized" | "html";
const requestId = "envelope_native_contract", privateToken = "OWNED-PRIVATE-SIGNING-TOKEN";
beforeAll(async () => {
  pdf = await renderToBuffer(createElement(Document, {}, createElement(Page, { size: "A4" }, createElement(Text, {}, "Actual private native signing fixture PDF"))));
  server = createServer((request, response) => { void (async () => {
    const path = request.url!, method = request.method!; calls.push({ method, path }); expect(request.headers.authorization).toBe("owned-test-token");
    const chunks: Buffer[] = []; for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
    response.setHeader("content-type", "application/json");
    if (path === "/api/v2/envelope/create") {
      const form = await new Request(origin + path, { method: "POST", headers: { "content-type": request.headers["content-type"]! }, body: new Uint8Array(bytes) }).formData(), file = form.get("files");
      expect(file).toBeInstanceOf(File); const actual = file as File, payload = form.get("payload"); if (typeof payload !== "string") throw Error("Owned native envelope payload required");
      stored = { payload: JSON.parse(payload) as Record<string, unknown>, bytes: Buffer.from(await actual.arrayBuffer()), fileName: actual.name, sent: false };
      if (fault === "lost-create") { response.destroy(); return; } response.end(JSON.stringify({ id: requestId })); return;
    }
    if (!stored) { response.writeHead(404).end("{}"); return; }
    if (path === "/api/v2/envelope/distribute") { expect(JSON.parse(bytes.toString())).toEqual({ envelopeId: requestId, meta: { distributionMethod: "EMAIL" } }); stored.sent = true;
      if (fault === "lost-send") { response.destroy(); return; } response.end(JSON.stringify({ success: true, id: requestId, recipients: [{ id: 1, token: privateToken }] })); return; }
    if (path !== "/api/v2/envelope/" + requestId) { response.writeHead(404).end("{}"); return; }
    if (fault === "html") { response.setHeader("content-type", "text/html"); response.end("PRIVATE-PROVIDER-HTML"); return; }
    if (fault === "oversized") { response.setHeader("content-length", String(signatureMaximumEvidenceBytes + 1)); response.end("{}"); return; }
    if (fault === "chunked-oversized") { response.write(Buffer.alloc(signatureMaximumEvidenceBytes + 1, 65)); response.end(); return; }
    const input = stored.payload, recipients = input.recipients as Array<{ name: string; email: string; role: string; fields: Array<Record<string, unknown>> }>; let nextField = 0;
    response.end(JSON.stringify({ id: requestId, type: "DOCUMENT", source: "DOCUMENT", visibility: fault === "public" ? "EVERYONE" : "ADMIN", title: input.title, externalId: fault === "wrong-reference" ? "different-native-reference" : input.externalId,
      status: stored.sent ? "PENDING" : "DRAFT", teamId: 17, documentMeta: { ...input.meta as object, distributionMethod: stored.sent ? "EMAIL" : "NONE" },
      recipients: recipients.map((recipient, index) => ({ id: index + 1, envelopeId: fault === "foreign-parent" ? "envelope_foreign" : requestId, name: recipient.name, email: recipient.email, role: recipient.role,
        readStatus: "NOT_OPENED", signingStatus: "NOT_SIGNED", sendStatus: stored!.sent ? "SENT" : "NOT_SENT", signedAt: null, expiresAt: null, token: privateToken })),
      envelopeItems: [{ id: "item_native_original", envelopeId: requestId, title: stored.fileName }], fields: recipients.flatMap((recipient, index) => recipient.fields.map(field => ({ ...field, id: ++nextField, recipientId: index + 1,
        envelopeItemId: "item_native_original", positionX: String(field.positionX), positionY: String(field.positionY), width: String(field.width), height: String(field.height) }))) }));
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned signature transport required"); origin = "http://127.0.0.1:" + address.port;
});
beforeEach(() => { calls = []; stored = null; fault = "none"; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function fixture(locale: "en" | "fr" | "ar" = "fr"): SignatureRequestInput { return { reference: "actual-native-signature-reference", title: "Actual private native signing fixture", locale, signingOrder: "SEQUENTIAL", methods: { typed: true, draw: false, upload: false },
  file: { name: "original-owned.pdf", bytes: new Uint8Array(pdf), sha256: createHash("sha256").update(pdf).digest("hex") }, recipients: [{ name: "Actual native fixture recipient", email: "native-recipient@example.test", role: "SIGNER", signingOrder: 1,
    fields: [{ type: "SIGNATURE", page: 1, positionX: 10, positionY: 80, width: 30, height: 5 }] }] }; }
const provider = (url = origin, transport: typeof fetch = fetch, nodeEnv: "test" | "production" = "test") => new DocumensoSignatureProvider({ DOCUMENSO_URL: url, DOCUMENSO_API_TOKEN: "owned-test-token", NODE_ENV: nodeEnv },
  () => Promise.reject(Error("Native envelope requests must not use the legacy recipient endpoint")), transport);

describe("actual bounded Documenso envelope protocol", () => {
  it.each(["en", "fr"] as const)("uploads actual immutable %s PDF bytes and separates draft creation, observation and explicit sending", async locale => {
    const p = provider(), input = fixture(locale), prepared = await p.prepareSignatureRequest(input); expect(prepared.requestId).toBe(requestId); expect(stored!.bytes).toEqual(pdf); expect(stored!.sent).toBe(false);
    expect(stored!.payload).toMatchObject({ externalId: input.reference, visibility: "ADMIN", meta: { language: locale, distributionMethod: "NONE", signingOrder: "SEQUENTIAL", typedSignatureEnabled: true, drawSignatureEnabled: false, uploadSignatureEnabled: false } });
    const draft = await p.readSignatureRequest({ requestId, reference: input.reference }); expect(draft).toMatchObject({ status: "DRAFT", requestId, reference: input.reference, locale, teamId: 17, distributionMethod: "NONE", methods: input.methods });
    expect(draft.fields[0]).toMatchObject(input.recipients[0].fields[0]); expect(draft.fields[0].recipientId).toBe(draft.recipients[0].id); const { evidence, ...facts } = draft; expect(Buffer.from(evidence).toString()).toContain(privateToken); expect(JSON.stringify(facts)).not.toContain(privateToken);
    const receipt = await p.distributeSignatureRequest({ requestId }); expect(receipt.requestId).toBe(requestId); const sent = await p.readSignatureRequest({ requestId, reference: input.reference }); expect(sent.status).toBe("PENDING"); expect(sent.recipients[0].sendStatus).toBe("SENT"); expect(sent.recipients[0].signingStatus).toBe("NOT_SIGNED"); expect(calls).toHaveLength(4);
  });
  it("captures bytes, recipient identity, selected methods and title before the caller can mutate the original input", async () => {
    const input = fixture(), pending = provider().prepareSignatureRequest(input); input.file.bytes.fill(0); input.title = "Later caller mutation"; input.recipients[0].email = "later@example.test"; input.methods.typed = false;
    await pending; expect(stored!.bytes).toEqual(pdf); expect(stored!.payload).toMatchObject({ title: "Actual private native signing fixture", recipients: [{ email: "native-recipient@example.test" }], meta: { typedSignatureEnabled: true } });
  });
  it.each(["lost-create", "lost-send"] as const)("reports %s as an uncertain external effect and never automatically replays it", async mode => {
    const p = provider(); if (mode === "lost-send") await p.prepareSignatureRequest(fixture()); fault = mode;
    await expect(mode === "lost-create" ? p.prepareSignatureRequest(fixture()) : p.distributeSignatureRequest({ requestId })).rejects.toMatchObject({ message: "signature_provider_unavailable", effect: "UNCERTAIN" });
    expect(stored).not.toBeNull(); expect(calls.filter(call => call.path.endsWith(mode === "lost-create" ? "/create" : "/distribute"))).toHaveLength(1);
    if (mode === "lost-send") expect(stored!.sent).toBe(true);
  });
  it.each(["wrong-reference", "foreign-parent", "public", "oversized", "chunked-oversized", "html"] as const)("denies %s readback without exposing provider body or signing capabilities", async mode => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input); fault = mode;
    await expect(p.readSignatureRequest({ requestId, reference: input.reference })).rejects.toMatchObject({ message: "signature_provider_unavailable", effect: "NONE" }); expect(calls).toHaveLength(2); expect(stored!.sent).toBe(false);
  });
  it("fails before I/O for altered bytes or unsupported Arabic signing metadata rather than choosing another language", async () => {
    const p = provider(), input = fixture(); input.file.bytes[10] ^= 1; await expect(p.prepareSignatureRequest(input)).rejects.toThrow("signature_provider_configuration_unavailable");
    await expect(p.prepareSignatureRequest(fixture("ar"))).rejects.toThrow("signature_provider_configuration_unavailable"); expect(calls).toHaveLength(0);
  });
  it.each(["http://signature.example.test", "https://user:private@signature.example.test", "https://signature.example.test/?token=private", "https://signature.example.test/#private"])("rejects an unsafe native endpoint before sending credentials: %s", async url => {
    const transport = vi.fn<typeof fetch>(); await expect(provider(url, transport).prepareSignatureRequest(fixture())).rejects.toThrow("signature_provider_configuration_unavailable"); expect(transport).not.toHaveBeenCalled();
  });
  it("keeps the existing development fake behind its production guard and never invents a signed outcome", async () => {
    expect(() => new FakeSignatureProvider("production")).toThrow("Fake providers cannot be used in production"); const p = new FakeSignatureProvider("test"), input = fixture(), result = await p.prepareSignatureRequest(input);
    expect((await p.readSignatureRequest({ requestId: result.requestId, reference: input.reference })).status).toBe("DRAFT"); await p.distributeSignatureRequest({ requestId: result.requestId });
    expect((await p.readSignatureRequest({ requestId: result.requestId, reference: input.reference })).status).toBe("PENDING");
  });
});
