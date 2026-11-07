import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealSignatureProviderEvidence, openSignatureProviderEvidence } from "@/modules/documents/infrastructure/signature-provider-payload";
import { signatureProviderEvidenceProtocol, signatureProviderEvidencePayloadSchema } from "@/modules/documents/domain/document-signature-provider-evidence";

function fixture() {
  const env = { NODE_ENV: "test" as const, ENCRYPTION_KEYS: "signature-provider-original:" + randomBytes(32).toString("base64") }, payload = signatureProviderEvidencePayloadSchema.parse({ protocol: signatureProviderEvidenceProtocol, schemaVersion: 1,
    identity: { organizationId: randomUUID(), signatureId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), evidenceId: randomUUID(), commandHash: "a".repeat(64), providerScopeHash: "b".repeat(64), contractHash: "c".repeat(64), originalPdfSha256: "d".repeat(64) },
    kind: "UNCERTAIN", providerRequestId: "envelope_owned_uncertain", observation: null,
    prepareReceipt: Buffer.from(JSON.stringify({ id: "envelope_owned_uncertain", token: "OWNED-PRIVATE-PROVIDER-CAPABILITY", email: "owned-private@example.test" })).toString("base64"), observationReceipt: null,
    scopeProof: { requestId: "envelope_owned_scope", reference: "owned-account-scope", teamId: 17, origin: "https://signature.example.test", fingerprint: "e".repeat(64) }, failureCode: "SIGNATURE_OUTCOME_UNCONFIRMED" });
  return { env, payload, ...sealSignatureProviderEvidence(payload, env) };
}
describe("encrypted native signature provider evidence", () => {
  it("retains reviewed GET identity proof without manufacturing a creation receipt or changing old ciphertext", () => {
    const f = fixture(), requestId = f.payload.providerRequestId!, observation = { requestId, reference: f.payload.identity.signatureId, title: "Owned original contract", status: "DRAFT", teamId: 17, locale: "fr", signingOrder: "SEQUENTIAL", methods: { typed: true, draw: false, upload: false }, distributionMethod: "NONE", allowDictateNextSigner: false, expiration: null, emailSettings: null, recipients: [], items: [{ id: "original_item", requestId, title: "original.pdf" }], fields: [] },
      payload = signatureProviderEvidencePayloadSchema.parse({ ...f.payload, kind: "PREPARED", observation, observationReceipt: Buffer.from(JSON.stringify(observation)).toString("base64"), prepareReceipt: null, preparationProof: "READBACK_IDENTITY_RECOVERY", identityRecovery: { id: randomUUID(), commandHash: "1".repeat(64), requestedBy: randomUUID(), reviewedIdentityHash: "2".repeat(64) }, failureCode: null }), sealed = sealSignatureProviderEvidence(payload, f.env);
    expect(openSignatureProviderEvidence(sealed.identity, sealed.cipher, f.env)).toEqual(payload); expect(payload.prepareReceipt).toBeNull(); expect(openSignatureProviderEvidence(f.identity, f.cipher, f.env)).toEqual(f.payload); expect(Object.hasOwn(f.payload, "identityRecovery")).toBe(false);
    for (const changed of [{ identityRecovery: null }, { preparationProof: null }, { prepareReceipt: f.payload.prepareReceipt }, { kind: "SIGNED" }, { observation: { ...observation, status: "PENDING", distributionMethod: "EMAIL" } }, { preparationIdentity: { evidenceId: randomUUID(), payloadSha256: "3".repeat(64), proof: "READBACK_IDENTITY_RECOVERY" } }]) expect(signatureProviderEvidencePayloadSchema.safeParse({ ...payload, ...changed }).success).toBe(false);
    const advanced = { ...payload, kind: "UNCERTAIN", observation: { ...observation, status: "CANCELLED", distributionMethod: "EMAIL" }, failureCode: "SIGNATURE_PRIVATE_PREPARATION_ADVANCED" }; expect(signatureProviderEvidencePayloadSchema.safeParse(advanced).success).toBe(true); expect(signatureProviderEvidencePayloadSchema.safeParse({ ...advanced, failureCode: "SIGNATURE_OUTCOME_UNCONFIRMED" }).success).toBe(false); expect(signatureProviderEvidencePayloadSchema.safeParse({ ...advanced, observation }).success).toBe(false);
  });
  it("preserves old preparation ciphertext while accepting an independently acknowledged native distribution", () => {
    const f = fixture(), old = openSignatureProviderEvidence(f.identity, f.cipher, f.env); expect(Object.hasOwn(old, "distributionProof")).toBe(false); expect(Object.hasOwn(old, "distributionReceipt")).toBe(false);
    const requestId = f.payload.providerRequestId!, observation = { requestId, reference: f.payload.identity.signatureId, title: "Owned technical signing contract", status: "PENDING", teamId: 17, locale: "fr", signingOrder: "SEQUENTIAL", methods: { typed: true, draw: false, upload: false }, distributionMethod: "EMAIL", allowDictateNextSigner: false, expiration: null, emailSettings: null,
      recipients: [{ id: 1, requestId, name: "Owned private recipient", email: "owned-private@example.test", role: "SIGNER", signingOrder: 1, readStatus: "NOT_OPENED", signingStatus: "NOT_SIGNED", sendStatus: "SENT", signedAt: null, expiresAt: null }], items: [{ id: "owned_item", requestId, title: "original.pdf" }], fields: [{ id: 1, recipientId: 1, itemId: "owned_item", type: "SIGNATURE", page: 1, positionX: 10, positionY: 80, width: 30, height: 5 }] },
      payload = signatureProviderEvidencePayloadSchema.parse({ ...f.payload, kind: "SENT", observation, observationReceipt: Buffer.from(JSON.stringify(observation)).toString("base64"), distributionProof: "POST_ACKNOWLEDGED", distributionReceipt: Buffer.from(JSON.stringify({ success: true, id: requestId })).toString("base64"), failureCode: null }), sealed = sealSignatureProviderEvidence(payload, f.env);
    expect(openSignatureProviderEvidence(sealed.identity, sealed.cipher, f.env)).toEqual(payload); expect(openSignatureProviderEvidence(f.identity, f.cipher, f.env)).toEqual(f.payload);
    const reconciled = { ...payload, distributionProof: "READBACK_RECONCILED" as const, distributionReceipt: null }, recovered = sealSignatureProviderEvidence(reconciled, f.env);
    expect(openSignatureProviderEvidence(recovered.identity, recovered.cipher, f.env)).toEqual(reconciled); expect(reconciled.distributionReceipt).toBeNull();
    for (const changed of [{ distributionProof: null }, { distributionProof: "POST_ACKNOWLEDGED", distributionReceipt: null }, { distributionProof: "READBACK_RECONCILED" }, { kind: "SIGNED" }, { observation: { ...observation, status: "DRAFT", distributionMethod: "NONE" } }]) expect(signatureProviderEvidencePayloadSchema.safeParse({ ...payload, ...changed }).success).toBe(false);
  });
  it("never turns an uncertain outcome into a reconciled or signed claim based only on a caller-supplied status", () => {
    const f = fixture(); expect(signatureProviderEvidencePayloadSchema.safeParse({ ...f.payload, distributionProof: "READBACK_RECONCILED" }).success).toBe(false);
    expect(signatureProviderEvidencePayloadSchema.safeParse({ ...f.payload, kind: "SENT", distributionProof: "READBACK_RECONCILED", failureCode: null }).success).toBe(false);
    expect(signatureProviderEvidencePayloadSchema.safeParse({ ...f.payload, kind: "SIGNED" }).success).toBe(false);
  });
  it("retains the original uncertain receipt without exposing contact details or provider capabilities", () => {
    const f = fixture(); expect(openSignatureProviderEvidence(f.identity, f.cipher, f.env)).toEqual(f.payload);
    for (const value of ["OWNED-PRIVATE-PROVIDER-CAPABILITY", "owned-private@example.test", f.payload.prepareReceipt!]) expect(Buffer.from(f.cipher).includes(Buffer.from(value))).toBe(false);
    expect(f.payload.kind).toBe("UNCERTAIN"); expect(f.payload.observation).toBeNull();
  });
  it("binds the complete tenant, native request, provider attempt, source PDF and original contract identities", () => {
    const f = fixture();
    for (const altered of [{ organizationId: randomUUID() }, { signatureId: randomUUID() }, { intentId: randomUUID() }, { attemptId: randomUUID() }, { evidenceId: randomUUID() },
      { commandHash: "1".repeat(64) }, { providerScopeHash: "2".repeat(64) }, { contractHash: "3".repeat(64) }, { originalPdfSha256: "4".repeat(64) }, { sha256: "5".repeat(64) }, { byteSize: f.identity.byteSize + 1 }]) {
      expect(() => openSignatureProviderEvidence({ ...f.identity, ...altered }, f.cipher, f.env)).toThrow("document_source_changed");
    }
  });
  it("rejects a modified ciphertext and recovers with retained historical keys after rotation", () => {
    const f = fixture(), original = Buffer.from(f.cipher), damaged = Buffer.from(f.cipher); damaged[damaged.length - 1] ^= 1;
    expect(() => openSignatureProviderEvidence(f.identity, damaged, f.env)).toThrow("document_source_changed");
    const next = "signature-provider-next:" + randomBytes(32).toString("base64");
    expect(() => openSignatureProviderEvidence(f.identity, f.cipher, { ...f.env, ENCRYPTION_KEYS: next })).toThrow("document_source_changed");
    expect(openSignatureProviderEvidence(f.identity, f.cipher, { ...f.env, ENCRYPTION_KEYS: next + "," + f.env.ENCRYPTION_KEYS })).toEqual(f.payload); expect(f.cipher).toEqual(original);
  });
  it("requires explicit encryption keys and rejects a fictitious prepared outcome without the actual private readback", () => {
    const f = fixture(), missing = { NODE_ENV: "test" as const, AUTH_SECRET: "owned-authentication-only" };
    expect(() => sealSignatureProviderEvidence(f.payload, missing)).toThrow("document_configuration_unavailable");
    expect(() => openSignatureProviderEvidence(f.identity, f.cipher, missing)).toThrow("document_configuration_unavailable");
    expect(signatureProviderEvidencePayloadSchema.safeParse({ ...f.payload, kind: "PREPARED", failureCode: null }).success).toBe(false);
    expect(signatureProviderEvidencePayloadSchema.safeParse({ ...f.payload, failureCode: null }).success).toBe(false);
  });
});
