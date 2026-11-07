import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createElement } from "react";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumensoSignatureProvider } from "@/platform/providers/real";
import { FakeSignatureProvider } from "@/platform/providers/fakes";
import { assertDistributedSignatureRequestObservation, assertSignatureRequestObservation, signatureMaximumEvidenceBytes, signatureMaximumPdfBytes, type SignatureRequestInput } from "@/platform/providers/signature-request";

let server: Server, origin: string, pdf: Buffer, completedPdf: Buffer, calls: Array<{ method: string; path: string }>, completed = false, stored: { payload: Record<string, unknown>; bytes: Buffer; fileName: string; sent: boolean } | null,
  fault: "none" | "lost-create" | "lost-send" | "wrong-reference" | "foreign-parent" | "public" | "oversized" | "chunked-oversized" | "html" | "pdf-html" | "pdf-oversized" | "pdf-chunked-oversized" | "pdf-truncated" | "pdf-redirect" | "pdf-invalid" | "completion-regressed";
const requestId = "envelope_native_contract", privateToken = "OWNED-PRIVATE-SIGNING-TOKEN";
beforeAll(async () => {
  pdf = await renderToBuffer(createElement(Document, {}, createElement(Page, { size: "A4" }, createElement(Text, {}, "Actual private native signing fixture PDF"))));
  completedPdf = await renderToBuffer(createElement(Document, {}, createElement(Page, { size: "A4" }, createElement(Text, {}, "Owned completed provider representation; transport fixture only"))));
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
    if (path.startsWith("/api/v2/envelope/item/item_native_original/download?version=")) {
      if (fault === "pdf-redirect") { response.writeHead(302, { location: origin + "/PRIVATE-SIGNING-URL" }).end(); return; }
      if (fault === "pdf-html") { response.setHeader("content-type", "text/html"); response.end("PRIVATE-PROVIDER-DOWNLOAD"); return; }
      response.setHeader("content-type", "application/pdf");
      if (fault === "pdf-oversized") { response.setHeader("content-length", String(signatureMaximumPdfBytes + 1)); response.end(pdf); return; }
      if (fault === "pdf-chunked-oversized") { response.write(Buffer.alloc(signatureMaximumPdfBytes + 1, 65)); response.end(); return; }
      if (fault === "pdf-truncated") { response.setHeader("connection", "close"); response.setHeader("content-length", String(pdf.length + 10)); response.end(pdf); return; }
      if (fault === "pdf-invalid") { response.end("not-a-pdf-private-body"); return; }
      if (fault === "completion-regressed") completed = false;
      response.end(new URL(origin + path).searchParams.get("version") === "signed" ? completedPdf : stored.bytes); return;
    }
    if (path === "/api/v2/envelope/distribute") { expect(JSON.parse(bytes.toString())).toEqual({ envelopeId: requestId, meta: { distributionMethod: "EMAIL" } }); stored.sent = true;
      if (fault === "lost-send") { response.destroy(); return; } response.end(JSON.stringify({ success: true, id: requestId, recipients: [{ id: 1, token: privateToken }] })); return; }
    if (path !== "/api/v2/envelope/" + requestId) { response.writeHead(404).end("{}"); return; }
    if (fault === "html") { response.setHeader("content-type", "text/html"); response.end("PRIVATE-PROVIDER-HTML"); return; }
    if (fault === "oversized") { response.setHeader("content-length", String(signatureMaximumEvidenceBytes + 1)); response.end("{}"); return; }
    if (fault === "chunked-oversized") { response.write(Buffer.alloc(signatureMaximumEvidenceBytes + 1, 65)); response.end(); return; }
    const input = stored.payload, recipients = input.recipients as Array<{ name: string; email: string; role: string; signingOrder: number; fields: Array<Record<string, unknown>> }>; let nextField = 0;
    response.end(JSON.stringify({ id: requestId, type: "DOCUMENT", source: "DOCUMENT", visibility: fault === "public" ? "EVERYONE" : "ADMIN", title: input.title, externalId: fault === "wrong-reference" ? "different-native-reference" : input.externalId,
      status: completed ? "COMPLETED" : stored.sent ? "PENDING" : "DRAFT", teamId: 17, documentMeta: { ...input.meta as object, distributionMethod: stored.sent ? "EMAIL" : "NONE" },
      recipients: recipients.map((recipient, index) => ({ id: index + 1, envelopeId: fault === "foreign-parent" ? "envelope_foreign" : requestId, name: recipient.name, email: recipient.email, role: recipient.role,
        signingOrder: recipient.signingOrder, readStatus: "NOT_OPENED", signingStatus: completed ? "SIGNED" : "NOT_SIGNED", sendStatus: stored!.sent ? "SENT" : "NOT_SENT", signedAt: completed ? "2026-11-06T12:00:00.000Z" : null, expiresAt: null, token: privateToken })),
      envelopeItems: [{ id: "item_native_original", envelopeId: requestId, title: stored.fileName }], fields: recipients.flatMap((recipient, index) => recipient.fields.map(field => ({ ...field, id: ++nextField, recipientId: index + 1,
        envelopeItemId: "item_native_original", positionX: String(field.positionX), positionY: String(field.positionY), width: String(field.width), height: String(field.height) }))) }));
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("Owned signature transport required"); origin = "http://127.0.0.1:" + address.port;
});
beforeEach(() => { calls = []; stored = null; completed = false; fault = "none"; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function fixture(locale: "en" | "fr" | "ar" = "fr"): SignatureRequestInput { return { reference: "actual-native-signature-reference", title: "Actual private native signing fixture", locale, signingOrder: "SEQUENTIAL", methods: { typed: true, draw: false, upload: false },
  file: { name: "original-owned.pdf", bytes: new Uint8Array(pdf), sha256: createHash("sha256").update(pdf).digest("hex") }, recipients: [{ name: "Actual native fixture recipient", email: "native-recipient@example.test", role: "SIGNER", signingOrder: 1,
    fields: [{ type: "SIGNATURE", page: 1, positionX: 10, positionY: 80, width: 30, height: 5 }] }] }; }
const provider = (url = origin, transport: typeof fetch = fetch, nodeEnv: "test" | "production" = "test") => new DocumensoSignatureProvider({ DOCUMENSO_URL: url, DOCUMENSO_API_TOKEN: "owned-test-token", NODE_ENV: nodeEnv },
  () => Promise.reject(Error("Native envelope requests must not use the legacy recipient endpoint")), transport);

describe("actual bounded Documenso envelope protocol", () => {
  it("confirms actual email distribution against the original PDF and rejects draft, rejected, cancelled or unsent readback", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input); await p.distributeSignatureRequest({ requestId });
    const download = await p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "original" }), scope = { requestId, teamId: 17, originalPdf: download.bytes };
    expect(() => assertDistributedSignatureRequestObservation(input, download.observation, scope)).not.toThrow(); expect(download.observation.status).toBe("PENDING"); expect(download.observation.recipients[0].signingStatus).toBe("NOT_SIGNED");
    for (const status of ["DRAFT", "REJECTED", "CANCELLED"] as const) expect(() => assertDistributedSignatureRequestObservation(input, { ...download.observation, status }, scope)).toThrow("signature_provider_unavailable");
    expect(() => assertDistributedSignatureRequestObservation(input, { ...download.observation, recipients: download.observation.recipients.map(recipient => ({ ...recipient, sendStatus: "NOT_SENT" })) }, scope)).toThrow("signature_provider_unavailable");
    expect(calls.filter(call => call.path.endsWith("/distribute"))).toHaveLength(1);
  });
  it("captures configured expiry and delivery controls explicitly and rejects changed or absent readback", async () => {
    const p = provider(), input = fixture(); input.delivery = { expiration: { unit: "day", amount: 17 }, reminders: { sendAfter: { disabled: true }, repeatEvery: { disabled: true } },
      emailSettings: { recipientSigningRequest: true, recipientRemoved: false, recipientSigned: false, documentPending: false, documentCompleted: true, documentDeleted: false, ownerDocumentCompleted: true, ownerRecipientExpired: true, ownerDocumentCreated: false } };
    await p.prepareSignatureRequest(input); expect(stored!.payload.meta).toMatchObject({ envelopeExpirationPeriod: input.delivery.expiration, reminderSettings: input.delivery.reminders, emailSettings: input.delivery.emailSettings, allowDictateNextSigner: false });
    const downloaded = await p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "original" }), scope = { requestId, teamId: 17, distributionMethod: "NONE" as const, originalPdf: downloaded.bytes };
    expect(() => assertSignatureRequestObservation(input, downloaded.observation, scope)).not.toThrow();
    for (const altered of [{ expiration: null }, { emailSettings: null }, { expiration: { disabled: true as const } }, { emailSettings: { ...input.delivery.emailSettings, documentCompleted: false } }]) {
      expect(() => assertSignatureRequestObservation(input, { ...downloaded.observation, ...altered }, scope)).toThrow("signature_provider_unavailable");
    }
    expect(calls.filter(call => call.path.endsWith("/distribute"))).toHaveLength(0);
  });
  it("verifies the real original PDF, selected team, exact recipients, per-recipient signing order and field geometry before a send", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input);
    const result = await p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "original" }), scope = { requestId, teamId: 17, distributionMethod: "NONE" as const, originalPdf: result.bytes };
    expect(() => assertSignatureRequestObservation(input, result.observation, scope)).not.toThrow();
    const wrongBytes = new Uint8Array(result.bytes); wrongBytes[20] ^= 1;
    for (const altered of [{ teamId: 18 }, { requestId: "envelope_foreign" }, { originalPdf: wrongBytes }]) expect(() => assertSignatureRequestObservation(input, result.observation, { ...scope, ...altered })).toThrow("signature_provider_unavailable");
    const changes = [
      { locale: "en" as const }, { title: "Unrelated original" }, { reference: "foreign-reference" }, { signingOrder: "PARALLEL" as const }, { methods: { ...input.methods, typed: false } }, { allowDictateNextSigner: true },
      { recipients: [{ ...result.observation.recipients[0], email: "different@example.test" }] },
      { recipients: [{ ...result.observation.recipients[0], signingOrder: 2 }] },
      { recipients: [{ ...result.observation.recipients[0], role: "VIEWER" as const }] },
      { recipients: [{ ...result.observation.recipients[0], sendStatus: "SENT" as const }] },
      { fields: [{ ...result.observation.fields[0], page: 2 }] }, { fields: [{ ...result.observation.fields[0], positionX: 25 }] },
      { fields: [{ ...result.observation.fields[0], itemId: "item_foreign" }] },
      { fields: [] }, { items: [...result.observation.items, { ...result.observation.items[0], id: "item_unapproved" }] }
    ];
    for (const change of changes) expect(() => assertSignatureRequestObservation(input, { ...result.observation, ...change }, scope)).toThrow("signature_provider_unavailable");
    expect(calls.filter(call => call.path.endsWith("/distribute"))).toHaveLength(0);
  });
  it("reads the actual original PDF through an authenticated fixed endpoint and captures its exact digest", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input);
    const result = await p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "original" });
    expect(result).toMatchObject({ requestId, itemId: "item_native_original", version: "original", sha256: input.file.sha256, observation: { status: "DRAFT", reference: input.reference } });
    expect(Buffer.from(result.bytes)).toEqual(pdf); expect(result.observation.recipients[0].signingOrder).toBe(input.recipients[0].signingOrder);
    expect(calls.map(call => call.path)).toEqual(["/api/v2/envelope/create", "/api/v2/envelope/" + requestId, "/api/v2/envelope/item/item_native_original/download?version=original", "/api/v2/envelope/" + requestId]);
    expect(stored!.sent).toBe(false);
  });
  it("requires provider completion before a signed download rather than accepting its unsigned fallback", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input);
    await expect(p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "signed" })).rejects.toMatchObject({ effect: "NONE" });
    expect(calls.some(call => call.path.includes("/download"))).toBe(false); expect(stored!.sent).toBe(false);
  });
  it("returns the completed representation only after confirming completion again after the PDF read", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input); await p.distributeSignatureRequest({ requestId }); completed = true;
    const result = await p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "signed" });
    expect(result.version).toBe("signed"); expect(Buffer.from(result.bytes)).toEqual(completedPdf); expect(Buffer.from(result.bytes)).not.toEqual(pdf);
    expect(result.sha256).toBe(createHash("sha256").update(completedPdf).digest("hex")); expect(result.observation.status).toBe("COMPLETED");
    expect(calls.slice(-3).map(call => call.path)).toEqual(["/api/v2/envelope/" + requestId, "/api/v2/envelope/item/item_native_original/download?version=signed", "/api/v2/envelope/" + requestId]);
  });
  it("discards a completed-looking PDF if the provider completion state changes during its read", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input); await p.distributeSignatureRequest({ requestId }); completed = true; fault = "completion-regressed";
    await expect(p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "signed" })).rejects.toMatchObject({ effect: "NONE", message: "signature_provider_unavailable" });
    expect(calls.filter(call => call.path.includes("/download"))).toHaveLength(1);
  });
  it.each(["pdf-html", "pdf-oversized", "pdf-chunked-oversized", "pdf-truncated", "pdf-redirect", "pdf-invalid"] as const)("rejects %s binary transport without following capabilities or leaking its body", async mode => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input); fault = mode;
    await expect(p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_native_original", version: "original" })).rejects.toMatchObject({ effect: "NONE", message: "signature_provider_unavailable" });
    expect(calls.filter(call => call.path.includes("/download"))).toHaveLength(1); expect(calls.some(call => call.path.includes("PRIVATE-SIGNING-URL"))).toBe(false); expect(stored!.sent).toBe(false);
  });
  it("rejects another item, reference and caller-controlled URL without downloading any PDF", async () => {
    const p = provider(), input = fixture(); await p.prepareSignatureRequest(input);
    await expect(p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "item_foreign", version: "original" })).rejects.toMatchObject({ effect: "NONE" });
    await expect(p.downloadSignatureRequest({ requestId, reference: "foreign-reference", itemId: "item_native_original", version: "original" })).rejects.toMatchObject({ effect: "NONE" });
    await expect(p.downloadSignatureRequest({ requestId, reference: input.reference, itemId: "https://foreign.example.test/private", version: "original" })).rejects.toThrow();
    expect(calls.some(call => call.path.includes("/download"))).toBe(false);
  });
  it("keeps fake original bytes independent and never fabricates a completed signed download", async () => {
    const p = new FakeSignatureProvider("test"), input = fixture(), receipt = await p.prepareSignatureRequest(input), command = { requestId: receipt.requestId, reference: input.reference, itemId: "fake-item-" + receipt.requestId, version: "original" as const }, first = await p.downloadSignatureRequest(command);
    first.bytes.fill(0); expect(Buffer.from((await p.downloadSignatureRequest(command)).bytes)).toEqual(pdf);
    await expect(p.downloadSignatureRequest({ ...command, version: "signed" })).rejects.toMatchObject({ effect: "NONE" });
  });
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
