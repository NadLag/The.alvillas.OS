import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentArchivePolicySchema, retainDocumentPrivacy } from "@/modules/documents/domain/document-policy";
import { documentUploadReviewInput, documentUploadInput } from "@/modules/documents/domain/document-command";

const type = { key: "original_house_rules", labels: { en: "Original house rules", fr: "Règlement intérieur initial", ar: "قواعد المنزل الأصلية" }, sources: ["PROPERTY"], privacy: ["sensitive"], content_types: ["application/pdf"], max_bytes: 100000 },
  policy = { source: "NATIVE_DOCUMENT_ARCHIVE", types: [type], encryption: "APP_MANAGED_AEAD", history: "APPEND_ONLY", downloads: "AUTHORIZED_SERVER_PROXY", upload_admission: { window_seconds: 60, max_requests: 5 }, storage_url_seconds: 30 },
  metadata = { documentId: null, source: { kind: "PROPERTY", id: randomUUID() }, typeKey: type.key, kind: "FILE", locale: "fr", title: "Original configured property rules", fileName: "Règlement original.pdf", contentType: "application/pdf", fileSize: 100, sha256: "a".repeat(64), supersedesId: null, effectiveFrom: null, templateKey: null };

describe("native document archive policy and metadata boundary", () => {
  it("requires explicit tenant types, privacy, limits and encrypted private storage", () => {
    expect(documentArchivePolicySchema.parse(policy)).toEqual(policy); expect(documentArchivePolicySchema.safeParse({}).success).toBe(false);
    for (const key of Object.keys(policy)) { const missing: Record<string, unknown> = { ...policy }; delete missing[key]; expect(documentArchivePolicySchema.safeParse(missing).success).toBe(false); }
  });
  it.each(["max_bytes", "privacy", "content_types", "sources"])("refuses an unauthored %s type rule", field => {
    const incomplete: Record<string, unknown> = { ...type }; delete incomplete[field]; expect(documentArchivePolicySchema.safeParse({ ...policy, types: [incomplete] }).success).toBe(false);
  });
  it("does not let a financial or person source lose its independent protection", () => {
    expect(documentArchivePolicySchema.safeParse({ ...policy, types: [{ ...type, sources: ["FINANCIAL_TRANSACTION"] }] }).success).toBe(false);
    expect(documentArchivePolicySchema.safeParse({ ...policy, types: [{ ...type, sources: ["PERSON"], privacy: ["operational"] }] }).success).toBe(false);
    expect(retainDocumentPrivacy(["sensitive"], ["operational"], "FINANCIAL_TRANSACTION")).toEqual(["financial", "operational", "sensitive"]);
    expect(retainDocumentPrivacy(["financial"], ["operational"], "PERSON")).toEqual(["financial", "operational", "sensitive"]);
  });
  it.each(["parent/contract.pdf", "parent\\contract.pdf", "line\nbreak.pdf", "spaced.pdf ", "spoof\u202e.pdf"])("refuses a path, control or ambiguous filename: %s", fileName => {
    expect(documentUploadReviewInput.safeParse({ ...metadata, fileName }).success).toBe(false);
  });
  it.each(["organizationId", "createdBy", "storageKey", "privacy", "signatureStatus", "signedPdfUrl"])("refuses caller-supplied %s", field => {
    expect(documentUploadReviewInput.safeParse({ ...metadata, [field]: randomUUID() }).success).toBe(false);
  });
  it("retains a configured original locale and an unknown legal effective date without guessing", () => {
    expect(documentUploadReviewInput.parse(metadata)).toEqual(metadata);
    expect(documentUploadInput.parse({ ...metadata, idempotencyKey: randomUUID(), reviewFingerprint: "b".repeat(64), reason: "Retain actual original configured document bytes" }).effectiveFrom).toBeNull();
  });
  it("requires original document and explicit template identity", () => {
    expect(documentUploadReviewInput.safeParse({ ...metadata, supersedesId: randomUUID() }).success).toBe(false);
    expect(documentUploadReviewInput.safeParse({ ...metadata, kind: "TEMPLATE" }).success).toBe(false);
    expect(documentUploadReviewInput.safeParse({ ...metadata, templateKey: "original_template" }).success).toBe(false);
  });
});
