import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticateDocumensoWebhook, decodeDocumensoWebhook, documensoDocumentEvents } from "@/modules/documents/infrastructure/documenso-webhook";
import { signatureMaximumEvidenceBytes } from "@/platform/providers/signature-request";

const secret = randomBytes(32).toString("base64url"), encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fixture() { return { event: "DOCUMENT_COMPLETED", createdAt: "2026-11-06T12:00:00.000Z", payload: { id: 21, envelopeId: "envelope_actual_native", externalId: "actual-native-signature-reference", source: "DOCUMENT", status: "COMPLETED",
  completedAt: "2026-11-06T11:59:00.000Z", organizationId: "UNTRUSTED-PROVIDER-TENANT", title: "PRIVATE-ORIGINAL-TITLE", recipients: [{ id: 1, envelopeId: "envelope_actual_native", role: "SIGNER",
    email: "private-recipient@example.test", name: "PRIVATE-RECIPIENT", token: "PRIVATE-SIGNING-TOKEN", readStatus: "OPENED", signingStatus: "SIGNED", sendStatus: "SENT", signedAt: "2026-11-06T11:59:00.000Z", expiresAt: null, expirationNotifiedAt: null }] } }; }

describe("authenticated canonical Documenso webhook evidence", () => {
  it.each([undefined, null, "", "incorrect", " ", "a".repeat(513)])("rejects unverified header %s before parsing even malformed private input", received => {
    expect(() => decodeDocumensoWebhook(received, secret, new Uint8Array([255]))).toThrow("signature_webhook_unauthorized");
  });
  it.each([undefined, "", " ", "a".repeat(513)])("denies missing or malformed configured secret %s", configured => {
    expect(authenticateDocumensoWebhook(secret, configured)).toBe(false); expect(() => decodeDocumensoWebhook(secret, configured, encode(fixture()))).toThrow("signature_webhook_unauthorized");
  });
  it.each(documensoDocumentEvents)("retains authenticated %s facts and the canonical v2 parent without exposing signing tokens as facts", event => {
    const body = fixture(), bytes = encode({ ...body, event }), result = decodeDocumensoWebhook(secret, secret, bytes), { evidence, ...facts } = result;
    expect(result.requestId).toBe(body.payload.envelopeId); expect(result.event).toBe(event); expect(result.reference).toBe(body.payload.externalId); expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence).toEqual(bytes); for (const marker of ["PRIVATE-ORIGINAL-TITLE", "PRIVATE-RECIPIENT", "PRIVATE-SIGNING-TOKEN", "UNTRUSTED-PROVIDER-TENANT", "private-recipient@example.test"]) expect(JSON.stringify(facts)).not.toContain(marker);
    expect(result).not.toHaveProperty("organizationId"); expect(result).not.toHaveProperty("signedVersionId");
  });
  it("deduplicates the same authenticated facts across JSON ordering and transport-only token changes while preserving each original evidence hash", () => {
    const body = fixture(), original = decodeDocumensoWebhook(secret, secret, encode(body)), changed = { ...body, payload: { ...body.payload, recipients: body.payload.recipients.map(value => ({ ...value, token: "ROTATED-PRIVATE-LINK" })) } };
    function reversed(value: unknown): unknown { if (Array.isArray(value)) return value.map(reversed); return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)])) : value; }
    const replay = decodeDocumensoWebhook(secret, secret, encode(reversed(changed))); expect(replay.eventId).toBe(original.eventId); expect(replay.evidenceSha256).not.toBe(original.evidenceSha256);
  });
  it("captures evidence bytes rather than retaining a mutable caller buffer", () => {
    const bytes = encode(fixture()), result = decodeDocumensoWebhook(secret, secret, bytes), original = new Uint8Array(bytes); bytes.fill(0);
    expect(result.evidence).toEqual(original); expect(result.requestId).toBe("envelope_actual_native");
  });
  it.each([{ name: "invalid UTF-8", bytes: new Uint8Array([255]) }, { name: "invalid JSON", bytes: new TextEncoder().encode("not-json") },
    { name: "empty body", bytes: new Uint8Array(0) }, { name: "oversized body", bytes: new Uint8Array(signatureMaximumEvidenceBytes + 1) }])("rejects $name without returning provider content", ({ bytes }) => {
    expect(() => decodeDocumensoWebhook(secret, secret, bytes)).toThrow("signature_webhook_invalid");
  });
  it("rejects legacy-only IDs, substituted recipient parents, duplicate recipients and template events", () => {
    const body = fixture();
    const invalid = [{ ...body, payload: { ...body.payload, envelopeId: undefined } }, { ...body, payload: { ...body.payload, recipients: [{ ...body.payload.recipients[0], envelopeId: "envelope_foreign" }] } },
      { ...body, payload: { ...body.payload, recipients: [body.payload.recipients[0], body.payload.recipients[0]] } }, { ...body, event: "TEMPLATE_USED" }];
    for (const value of invalid) expect(() => decodeDocumensoWebhook(secret, secret, encode(value))).toThrow("signature_webhook_invalid");
  });
  it("preserves a recipient-level signed observation without fabricating a completed native signature", () => {
    const body = fixture(), result = decodeDocumensoWebhook(secret, secret, encode({ ...body, event: "DOCUMENT_SIGNED", payload: { ...body.payload, status: "PENDING", completedAt: null } }));
    expect(result.event).toBe("DOCUMENT_SIGNED"); expect(result.status).toBe("PENDING"); expect(result.completedAt).toBeNull(); expect(result).not.toHaveProperty("state"); expect(result).not.toHaveProperty("signedVersionId");
  });
});
