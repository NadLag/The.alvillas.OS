import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureRequestObservationSchema } from "@/platform/providers/signature-contract";
import { decodeDocumensoWebhook } from "@/modules/documents/infrastructure/documenso-webhook";
import { classifySignatureWebhook } from "@/modules/documents/application/document-signature-webhook-observation";

const secret = "owned-webhook-unit-authentication-only";
function fixture(event = "DOCUMENT_SENT") {
  const requestId = "envelope_owned_actual", reference = randomUUID(), recipient = { id: 1, envelopeId: requestId, role: "SIGNER", readStatus: "NOT_OPENED", signingStatus: "NOT_SIGNED", sendStatus: "SENT", signedAt: null as string | null, expiresAt: null as string | null, expirationNotifiedAt: null as string | null },
    body = { event, createdAt: "2026-11-06T10:02:00.000Z", payload: { envelopeId: requestId, externalId: reference, source: "DOCUMENT", status: "PENDING", completedAt: null as string | null, recipients: [recipient] } },
    actual = signatureRequestObservationSchema.parse({ requestId, reference, title: "Retained actual contract", status: "PENDING", teamId: 17, locale: "fr", signingOrder: "SEQUENTIAL", methods: { typed: true, draw: false, upload: false }, distributionMethod: "EMAIL", allowDictateNextSigner: false, expiration: null, emailSettings: null,
      recipients: [{ id: 1, requestId, name: "Original recipient", email: "original@example.test", role: "SIGNER", signingOrder: 1, readStatus: "NOT_OPENED", signingStatus: "NOT_SIGNED", sendStatus: "SENT", signedAt: null, expiresAt: null }], items: [{ id: "actual_original_item", requestId, title: "original.pdf" }], fields: [{ id: 1, recipientId: 1, itemId: "actual_original_item", type: "SIGNATURE", page: 1, positionX: 10, positionY: 80, width: 30, height: 5 }], evidence: new Uint8Array([1, 2, 3]) });
  return { body, actual, facts: () => decodeDocumensoWebhook(secret, secret, new TextEncoder().encode(JSON.stringify(body))) };
}
describe("authenticated webhook facts verified against their actual original request", () => {
  it("confirms sent readback without fabricating a signed original", () => { const f = fixture(); expect(classifySignatureWebhook(f.facts(), f.actual)).toEqual({ kind: "SENT", completionObserved: false }); });
  it("requires both original recipient identities and actual open facts", () => {
    const f = fixture("DOCUMENT_OPENED"); f.body.payload.recipients[0].readStatus = "OPENED"; expect(() => classifySignatureWebhook(f.facts(), f.actual)).toThrow("document_source_changed"); f.actual.recipients[0].readStatus = "OPENED"; expect(classifySignatureWebhook(f.facts(), f.actual).kind).toBe("VIEWED");
    f.body.payload.recipients[0].id = 19; expect(() => classifySignatureWebhook(f.facts(), f.actual)).toThrow("document_source_changed");
  });
  it("requires an actual required recipient rejection instead of mapping cancellation to decline", () => {
    const f = fixture("DOCUMENT_REJECTED"); f.body.payload.recipients[0].signingStatus = "REJECTED"; expect(() => classifySignatureWebhook(f.facts(), f.actual)).toThrow(); f.actual.recipients[0].signingStatus = "REJECTED"; f.actual.status = "REJECTED"; expect(classifySignatureWebhook(f.facts(), f.actual).kind).toBe("DECLINED");
    f.body.event = "DOCUMENT_CANCELLED"; f.actual.status = "CANCELLED"; expect(classifySignatureWebhook(f.facts(), f.actual)).toEqual({ kind: "OBSERVED", completionObserved: false });
  });
  it("requires an actual elapsed unsigned recipient deadline and its authenticated notification", () => {
    const f = fixture("RECIPIENT_EXPIRED"), recipient = f.body.payload.recipients[0]; recipient.expiresAt = "2026-11-06T11:00:00.000+01:00"; recipient.expirationNotifiedAt = "2026-11-06T10:01:00.000Z"; f.actual.recipients[0].expiresAt = "2026-11-06T10:00:00.000Z"; expect(classifySignatureWebhook(f.facts(), f.actual).kind).toBe("EXPIRED");
    for (const value of [null, "2026-11-06T09:59:00.000Z", "2026-11-06T10:03:00.000Z"]) { recipient.expirationNotifiedAt = value; expect(() => classifySignatureWebhook(f.facts(), f.actual)).toThrow(); }
    recipient.expirationNotifiedAt = "2026-11-06T10:01:00.000Z"; f.actual.recipients[0].signingStatus = "SIGNED"; expect(() => classifySignatureWebhook(f.facts(), f.actual)).toThrow();
  });
  it("retains a partial signature without completing the request or inventing an archived signed version", () => {
    const f = fixture("DOCUMENT_SIGNED"), at = "2026-11-06T10:01:00.000Z"; f.body.payload.recipients[0].signingStatus = "SIGNED"; f.body.payload.recipients[0].signedAt = "2026-11-06T11:01:00.000+01:00"; f.actual.recipients[0].signingStatus = "SIGNED"; f.actual.recipients[0].signedAt = at; f.actual.recipients.push({ ...f.actual.recipients[0], id: 2, name: "Actual second required signer", email: "second@example.test", signingOrder: 2, signingStatus: "NOT_SIGNED", signedAt: null });
    const partial = classifySignatureWebhook(f.facts(), f.actual); expect(partial).toEqual({ kind: "OBSERVED", completionObserved: false }); expect(partial).not.toHaveProperty("signedVersionId");
    f.actual.status = "COMPLETED"; expect(classifySignatureWebhook(f.facts(), f.actual).completionObserved).toBe(false); f.actual.recipients[1].signingStatus = "SIGNED"; f.actual.recipients[1].signedAt = at; const complete = classifySignatureWebhook(f.facts(), f.actual); expect(complete).toEqual({ kind: "OBSERVED", completionObserved: true }); expect(complete.kind).not.toBe("SIGNED");
  });
  it("rejects claimed completion before every actual required action is signed", () => {
    const f = fixture("DOCUMENT_COMPLETED"); f.body.payload.status = "COMPLETED"; f.body.payload.completedAt = "2026-11-06T10:01:00.000Z"; f.actual.status = "COMPLETED"; expect(() => classifySignatureWebhook(f.facts(), f.actual)).toThrow();
    f.actual.recipients[0].signingStatus = "SIGNED"; f.actual.recipients[0].signedAt = "2026-11-06T10:01:00.000Z"; expect(classifySignatureWebhook(f.facts(), f.actual).completionObserved).toBe(true);
  });
  it("rejects a substituted provider parent or native signature reference", () => { const f = fixture(), facts = f.facts(); for (const changed of [{ requestId: "envelope_other_parent" }, { reference: randomUUID() }]) expect(() => classifySignatureWebhook({ ...facts, ...changed }, f.actual)).toThrow(); });
});
