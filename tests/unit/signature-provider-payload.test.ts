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
