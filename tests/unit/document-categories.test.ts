import { describe, expect, it } from "vitest";
import { documentCategories, documentTypePolicySchema, retainedDocumentCategory, retainDocumentPrivacy } from "@/modules/documents/domain/document-policy";

const type = { key: "configured_original", labels: { en: "Original", fr: "Original", ar: "الأصل" }, sources: ["ORGANIZATION"], privacy: ["financial", "sensitive"], content_types: ["application/pdf"], max_bytes: 1024 };

describe("explicit approved document classifications", () => {
  it.each(documentCategories)("accepts explicitly configured %s with independently protected privacy", category => {
    expect(documentTypePolicySchema.parse({ ...type, category }).category).toBe(category);
  });
  it.each(["INVOICE", "RECEIPT"])("requires financial protection for %s even without a transaction source", category => {
    expect(documentTypePolicySchema.safeParse({ ...type, category, privacy: ["sensitive", "operational"] }).success).toBe(false);
  });
  it.each(["OWNER_CONTRACT", "GUEST_AGREEMENT", "SUPPLIER", "STAFF"])("requires sensitive protection for %s even on an organization template", category => {
    expect(documentTypePolicySchema.safeParse({ ...type, category, privacy: ["financial", "operational"] }).success).toBe(false);
  });
  it.each(["SUPPLIER", "GUEST"] as const)("retains sensitive protection for the actual %s source independently of category", source => {
    expect(documentTypePolicySchema.safeParse({ ...type, sources: [source], privacy: ["operational"] }).success).toBe(false);
    expect(retainDocumentPrivacy(["financial"], [], source)).toEqual(["financial", "sensitive"]);
  });
  it("preserves unclassified historical and custom types without inference or mutation", () => {
    const original = { value: { types: [{ ...type, key: "owner_contract" }] } };
    expect(retainedDocumentCategory(original, "owner_contract")).toEqual({});
    expect(documentTypePolicySchema.parse(type)).toEqual(type);
    expect(original.value.types[0]).not.toHaveProperty("category");
  });
  it("reads only the matching type from the original captured policy", () => {
    const original = { value: { types: [{ ...type, category: "INVOICE" }, { ...type, key: "other", category: "RECEIPT" }] } };
    const replacement = { ...original, value: { types: [{ ...type, category: "REPORT" }] } };
    expect(retainedDocumentCategory(original, type.key)).toEqual({ category: "INVOICE" });
    expect(retainedDocumentCategory(replacement, type.key)).toEqual({ category: "REPORT" });
    expect(retainedDocumentCategory(original, "absent")).toEqual({});
    expect(original.value.types[0].category).toBe("INVOICE");
  });
  it.each([null, "invoice", "UNKNOWN", { key: "INVOICE" }])("refuses an invalid explicit category %j", category => {
    expect(documentTypePolicySchema.safeParse({ ...type, category }).success).toBe(false);
    expect(() => retainedDocumentCategory({ value: { types: [{ ...type, category }] } }, type.key)).toThrow();
  });
});
