import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentGenerationCommandSchema, documentGenerationSnapshotSchema, documentGenerationProtocol } from "@/modules/documents/domain/document-generation";
import { encodeDocumentGenerationInput, sealDocumentGenerationInput, openDocumentGenerationInput } from "@/modules/documents/infrastructure/document-generation-payload";

function fixture() {
  const env = { NODE_ENV: "test" as const, ENCRYPTION_KEYS: "generation-original:" + randomBytes(32).toString("base64") }, templateVersionId = randomUUID(), input = {
    source: { templateKey: "actual_agreement", locale: "fr", title: "Convention originale", blocks: [{ kind: "PARAGRAPH", text: "Texte privé original / 9 007 199 254 740 993,07 MAD" }], privacy: ["financial"] },
    provenance: { templateVersionId, templateSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) }, maximumBytes: 1048576
  }, bytes = encodeDocumentGenerationInput(input), identity = { organizationId: randomUUID(), documentId: randomUUID(), instanceId: randomUUID(), templateVersionId, templateSha256: input.provenance.templateSha256,
    sourceFingerprint: input.provenance.sourceFingerprint, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
  const cipher = sealDocumentGenerationInput(identity, bytes, env), otherVersionId = randomUUID(), command = { templateVersionId, variantVersionIds: [templateVersionId, otherVersionId], source: { kind: "PROPERTY", id: randomUUID() }, title: "Original archive caption", effectiveFrom: null, idempotencyKey: randomUUID(), reviewFingerprint: "c".repeat(64), reason: "Preserve the actual original native render input" }, snapshot = {
    protocol: documentGenerationProtocol, schemaVersion: 1, identity, command, commandHash: "d".repeat(64), nativeSourceFingerprint: "e".repeat(64),
    authorizationCap: { schemaVersion: 1, organizationId: identity.organizationId, userAccountId: randomUUID(), permissions: [], scopes: [{ organizationId: identity.organizationId, scopeType: "organization" }] },
    policySnapshot: { id: randomUUID(), version: 1, value: { source: "NATIVE_DOCUMENT_ARCHIVE", encryption: "APP_MANAGED_AEAD", history: "APPEND_ONLY", downloads: "AUTHORIZED_SERVER_PROXY", storage_url_seconds: 30,
      upload_admission: { window_seconds: 3600, max_requests: 100 }, upload_transport: { window_seconds: 3600, max_requests: 100 }, types: [{ key: "actual_agreement", labels: { en: "Agreement", fr: "Convention", ar: "اتفاقية" }, sources: ["PROPERTY"], privacy: ["financial"], content_types: ["application/pdf"], max_bytes: 1048576 }] } },
    variants: [{ versionId: templateVersionId, sha256: "a".repeat(64), locale: "fr" }, { versionId: otherVersionId, sha256: "f".repeat(64), locale: "en" }], contractFingerprint: "a".repeat(64), payloadCipher: cipher.toString("base64")
  };
  return { env, input, bytes, identity, cipher, command, snapshot };
}
describe("immutable native document generation inputs", () => {
  it("retains original private clauses and exact formatted Money in authenticated encrypted input", () => {
    const f = fixture(); expect(openDocumentGenerationInput(f.identity, f.cipher, f.env)).toEqual(f.input); expect(f.cipher.includes(Buffer.from("Texte privé original"))).toBe(false); expect(documentGenerationSnapshotSchema.parse(f.snapshot)).toEqual(f.snapshot);
  });
  it.each(["organizationId", "documentId", "instanceId", "templateVersionId"] as const)("rejects substitution of native %s", field => {
    const f = fixture(); expect(() => openDocumentGenerationInput({ ...f.identity, [field]: randomUUID() }, f.cipher, f.env)).toThrow(/^document_storage_unavailable$/u);
  });
  it.each(["templateSha256", "sourceFingerprint", "sha256"] as const)("rejects substitution of original %s", field => {
    const f = fixture(); expect(() => openDocumentGenerationInput({ ...f.identity, [field]: "9".repeat(64) }, f.cipher, f.env)).toThrow(/^document_storage_unavailable$/u);
  });
  it("rejects changed native byte size and corrupted ciphertext without revealing source text", () => {
    const f = fixture(), damaged = Buffer.from(f.cipher); damaged[damaged.length - 1] ^= 1;
    expect(() => openDocumentGenerationInput({ ...f.identity, byteSize: f.identity.byteSize + 1 }, f.cipher, f.env)).toThrow(/^document_storage_unavailable$/u);
    expect(() => openDocumentGenerationInput(f.identity, damaged, f.env)).toThrow(/^document_storage_unavailable$/u);
  });
  it("requires explicit encryption keys and never falls back to an authentication secret", () => {
    const f = fixture(), missing = { NODE_ENV: "test" as const, AUTH_SECRET: "owned-test-authentication-only" };
    expect(() => sealDocumentGenerationInput(f.identity, f.bytes, missing)).toThrow("document_configuration_unavailable"); expect(() => openDocumentGenerationInput(f.identity, f.cipher, missing)).toThrow("document_configuration_unavailable");
  });
  it("recovers with historical keys after rotation while preserving the original ciphertext", () => {
    const f = fixture(), hash = createHash("sha256").update(f.cipher).digest("hex"), next = "generation-new:" + randomBytes(32).toString("base64");
    expect(() => openDocumentGenerationInput(f.identity, f.cipher, { ...f.env, ENCRYPTION_KEYS: next })).toThrow("document_storage_unavailable");
    expect(openDocumentGenerationInput(f.identity, f.cipher, { ...f.env, ENCRYPTION_KEYS: next + "," + f.env.ENCRYPTION_KEYS })).toEqual(f.input); expect(createHash("sha256").update(f.cipher).digest("hex")).toBe(hash);
  });
  it("captures original bytes instead of retaining a mutable caller buffer", () => {
    const f = fixture(), original = structuredClone(f.input); f.bytes.fill(0); expect(openDocumentGenerationInput(f.identity, f.cipher, f.env)).toEqual(original);
  });
  it("rejects a caller value, amount, authority or tenant field in the public generation command", () => {
    const f = fixture(); for (const extra of [{ values: { amount: "0.00" } }, { amount: "0.00" }, { authorizationCap: {} }, { organizationId: randomUUID() }]) expect(documentGenerationCommandSchema.safeParse({ ...f.command, ...extra }).success).toBe(false);
  });
  it("requires explicit EN/FR original version identities and forbids a substituted selected template hash", () => {
    const f = fixture(); expect(documentGenerationSnapshotSchema.safeParse({ ...f.snapshot, variants: [f.snapshot.variants[0]] }).success).toBe(false);
    expect(documentGenerationSnapshotSchema.safeParse({ ...f.snapshot, variants: [f.snapshot.variants[0], { ...f.snapshot.variants[1], locale: "fr" }] }).success).toBe(false);
    expect(documentGenerationSnapshotSchema.safeParse({ ...f.snapshot, variants: [{ ...f.snapshot.variants[0], sha256: "9".repeat(64) }, f.snapshot.variants[1]] }).success).toBe(false);
  });
  it("requires an explicit complete variant selection without duplicate, missing or substituted original versions", () => {
    const f = fixture();
    for (const variantVersionIds of [[f.identity.templateVersionId], [f.identity.templateVersionId, f.identity.templateVersionId], [randomUUID(), randomUUID()]]) expect(documentGenerationCommandSchema.safeParse({ ...f.command, variantVersionIds }).success).toBe(false);
    expect(documentGenerationSnapshotSchema.safeParse({ ...f.snapshot, command: { ...f.command, variantVersionIds: [f.identity.templateVersionId, randomUUID()] } }).success).toBe(false);
  });
  it("rejects an unrelated captured tenant and missing or oversized encrypted input", () => {
    const f = fixture(); expect(documentGenerationSnapshotSchema.safeParse({ ...f.snapshot, authorizationCap: { ...f.snapshot.authorizationCap, organizationId: randomUUID() } }).success).toBe(false);
    for (const payloadCipher of ["", "YWJj", Buffer.alloc(f.identity.byteSize + 257).toString("base64")]) expect(documentGenerationSnapshotSchema.safeParse({ ...f.snapshot, payloadCipher }).success).toBe(false);
  });
  it("rejects input whose immutable template/source metadata disagrees with the actual render request", () => {
    const f = fixture(); expect(() => sealDocumentGenerationInput({ ...f.identity, templateVersionId: randomUUID() }, f.bytes, f.env)).toThrow("document_source_changed");
    expect(() => sealDocumentGenerationInput({ ...f.identity, templateSha256: "9".repeat(64) }, f.bytes, f.env)).toThrow("document_source_changed");
    expect(() => sealDocumentGenerationInput({ ...f.identity, sourceFingerprint: "9".repeat(64) }, f.bytes, f.env)).toThrow("document_source_changed");
  });
});
