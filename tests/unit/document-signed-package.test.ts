import { createHash } from "node:crypto";
import { createElement } from "react";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { readCompletedSignaturePackage } from "@/modules/documents/infrastructure/signed-signature-package";
import { signatureRequestMetadataSchema } from "@/platform/providers/signature-request";
import { ownedSignatureProvider } from "../integration/support/document-signature-provider";

const originalClause = "Original exact contract amount 9007199254740993.07 MAD remains payable to its actual owner";
async function pdf(text: string) { return new Uint8Array(await renderToBuffer(createElement(Document, {}, createElement(Page, { size: "A4" }, createElement(Text, {}, text))))); }
async function fixture() {
  const http = await ownedSignatureProvider(), original = await pdf(originalClause), input = { reference: "original_native_signed_archive", title: "Original signed archive contract", locale: "fr" as const, signingOrder: "SEQUENTIAL" as const, methods: { typed: true, draw: false, upload: false }, file: { name: "original.pdf", bytes: original, sha256: createHash("sha256").update(original).digest("hex") }, recipients: [{ name: "Owned actual signer", email: "original-signer@example.test", role: "SIGNER" as const, signingOrder: 1, fields: [{ type: "SIGNATURE" as const, page: 1, positionX: 10, positionY: 80, width: 30, height: 5 }] }] };
  const { requestId } = await http.provider.prepareSignatureRequest(input); await http.provider.distributeSignatureRequest({ requestId }); http.state.lifecycle = { status: "COMPLETED", signingStatus: "SIGNED", signedAt: new Date().toISOString() }; http.state.signedPdf = await pdf(originalClause + " Owned completed signing representation; technical fixture only"); http.state.certificatePdf = await pdf("Owned provider completion certificate " + requestId + " original-signer@example.test; no legal acceptance claim");
  const account = { origin: http.origin, teamId: http.teamId, scopeEnvelopeId: http.scopeEnvelopeId, scopeReference: http.scopeReference }, metadata = signatureRequestMetadataSchema.parse({ ...input, file: { name: input.file.name, sha256: input.file.sha256 } }), options = { env: { NODE_ENV: "test" as const }, provider: http.provider, providerOrigin: http.origin };
  return { http, original, input, requestId, account, metadata, options, read: () => readCompletedSignaturePackage(account, metadata, requestId, 1024 * 1024, options) };
}
describe("read-only complete original signed package", () => {
  it("retains the exact original contract, actual signed PDF and separate authenticated certificate without another POST", async () => {
    const f = await fixture(); try { const before = f.http.calls.filter(call => call.method === "POST").length, result = await f.read(); expect(result.signed.sha256).toBe(createHash("sha256").update(f.http.state.signedPdf!).digest("hex")); expect(result.certificate.sha256).toBe(createHash("sha256").update(f.http.state.certificatePdf!).digest("hex")); expect(result.signed.sha256).not.toBe(f.input.file.sha256); expect(result.certificate.sha256).not.toBe(result.signed.sha256); expect(result.scopeProof.teamId).toBe(f.http.teamId); expect(result.observation.status).toBe("COMPLETED"); expect(f.http.calls.filter(call => call.method === "POST")).toHaveLength(before); } finally { await f.http.close(); }
  });
  it.each(["wrong-team", "wrong-pdf", "substituted-recipient", "fail-read"] as const)("rejects %s rather than trusting completed-looking bytes", async fault => {
    const f = await fixture(); try { f.http.state.fault = fault; await expect(f.read()).rejects.toThrow(); expect(f.http.calls.filter(call => call.path.includes("certificate/download"))).toHaveLength(0); } finally { await f.http.close(); }
  });
  it("rejects incomplete required actions before downloading either claimed signed artifact", async () => { const f = await fixture(); try { f.http.state.recipientLifecycle[1] = { signingStatus: "NOT_SIGNED", signedAt: null }; await expect(f.read()).rejects.toThrow(); expect(f.http.calls.some(call => call.path.includes("version=signed") || call.path.includes("certificate/download"))).toBe(false); } finally { await f.http.close(); } });
  it.each(["original", "different-contract", "invalid-pdf"] as const)("rejects a %s representation returned as the signed original", async mode => { const f = await fixture(); try { f.http.state.signedPdf = mode === "original" ? f.original : mode === "different-contract" ? await pdf("A substituted unsigned business agreement") : new TextEncoder().encode("not a PDF"); await expect(f.read()).rejects.toThrow(); } finally { await f.http.close(); } });
  it("rejects a document returned as the certificate and a completion regression during its actual read", async () => { const f = await fixture(); try { const certificate = f.http.state.certificatePdf; f.http.state.certificatePdf = f.original; await expect(f.read()).rejects.toThrow(); f.http.state.certificatePdf = certificate; f.http.state.afterCertificate = () => { f.http.state.lifecycle = { status: "PENDING", signingStatus: "NOT_SIGNED", signedAt: null }; return Promise.resolve(); }; await expect(f.read()).rejects.toThrow(); } finally { await f.http.close(); } });
});
