import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativeSignatureCommandSchema, nativeSignatureRecipientProtocol } from "@/modules/documents/domain/document-signature-command";
import { openNativeSignatureRecipient, sealNativeSignatureRecipient } from "@/modules/documents/infrastructure/document-signature-recipient-payload";

function fixture() {
  const env = { NODE_ENV: "test" as const, ENCRYPTION_KEYS: "signature-original:" + randomBytes(32).toString("base64") },
    identity = { organizationId: randomUUID(), signatureId: randomUUID(), recipientId: randomUUID(), reference: { kind: "OWNER" as const, id: randomUUID() }, fingerprint: "a".repeat(64) },
    payload: Parameters<typeof sealNativeSignatureRecipient>[0] = { protocol: nativeSignatureRecipientProtocol, schemaVersion: 1, identity, displayName: "Propriétaire original", email: "private-owner@example.test" };
  return { env, identity, payload, cipher: sealNativeSignatureRecipient(payload, env) };
}
describe("native signature recipient evidence", () => {
  it("encrypts original native contact data and binds every recipient and request identity", () => {
    const f = fixture(); expect(Buffer.from(f.cipher).includes(Buffer.from(f.payload.email))).toBe(false);
    expect(openNativeSignatureRecipient(f.identity, f.cipher, f.env)).toEqual(f.payload);
    for (const altered of [{ organizationId: randomUUID() }, { signatureId: randomUUID() }, { recipientId: randomUUID() },
      { reference: { ...f.identity.reference, id: randomUUID() } }, { fingerprint: "b".repeat(64) }]) {
      expect(() => openNativeSignatureRecipient({ ...f.identity, ...altered }, f.cipher, f.env)).toThrow("document_source_changed");
    }
  });
  it("rejects modified ciphertext and missing historical keys without rewriting its original", () => {
    const f = fixture(), original = Buffer.from(f.cipher), damaged = Buffer.from(f.cipher); damaged[damaged.length - 1] ^= 1;
    expect(() => openNativeSignatureRecipient(f.identity, damaged, f.env)).toThrow("document_source_changed");
    const next = "signature-next:" + randomBytes(32).toString("base64");
    expect(() => openNativeSignatureRecipient(f.identity, f.cipher, { ...f.env, ENCRYPTION_KEYS: next })).toThrow("document_source_changed");
    expect(openNativeSignatureRecipient(f.identity, f.cipher, { ...f.env, ENCRYPTION_KEYS: next + "," + f.env.ENCRYPTION_KEYS })).toEqual(f.payload);
    expect(f.cipher).toEqual(original);
  });
  it("requires explicit encryption keys even when an authentication secret exists", () => {
    const f = fixture(), missing = { NODE_ENV: "test" as const, AUTH_SECRET: "owned-test-only-authentication-secret" };
    expect(() => sealNativeSignatureRecipient(f.payload, missing)).toThrow("document_configuration_unavailable");
    expect(() => openNativeSignatureRecipient(f.identity, f.cipher, missing)).toThrow("document_configuration_unavailable");
  });
  it("accepts only bounded native references and rejects caller contacts, financial values and authority", () => {
    const f = fixture(), command = { instanceId: randomUUID(), documentVersionId: randomUUID(), recipients: [f.identity.reference],
      idempotencyKey: randomUUID(), reviewFingerprint: "c".repeat(64), reason: "Request the exact retained native agreement" };
    expect(nativeSignatureCommandSchema.safeParse(command).success).toBe(true);
    for (const extra of [{ organizationId: randomUUID() }, { email: f.payload.email }, { amount: "0.00" }, { authorizationCap: {} }, { providerRequestId: "guessed" }]) {
      expect(nativeSignatureCommandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
    }
    for (const recipients of [[], [f.identity.reference, f.identity.reference], [{ ...f.identity.reference, email: f.payload.email }],
      Array.from({ length: 101 }, () => ({ kind: "OWNER", id: randomUUID() }))]) {
      expect(nativeSignatureCommandSchema.safeParse({ ...command, recipients }).success).toBe(false);
    }
  });
});
