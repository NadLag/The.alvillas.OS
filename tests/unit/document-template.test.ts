import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { documentTemplateDefinitionSchema, documentTemplateVariantsSchema, renderDocumentTemplate, selectDocumentTemplateVariant, templateReferences,
  encodeDocumentTemplate, decodeDocumentTemplate, type DocumentTemplateBinding } from "@/modules/documents/domain/document-template";

const definition = (locale: "en" | "fr" | "ar" = "en") => ({ schemaVersion: 1, templateKey: "owner_agreement", locale, title: "Agreement {{property}}", variables: [{ key: "property", kind: "TEXT" }], blocks: [{ kind: "PARAGRAPH", text: "Retained agreement for {{ property }}." }] });
const property = (value = "Villa Atlas"): DocumentTemplateBinding => ({ kind: "TEXT", value, privacy: ["operational"] });
describe("native document template definitions and exact classified interpolation", () => {
  it("uses only explicitly declared exact keys and retains repeated references", () => {
    const rendered = renderDocumentTemplate(definition(), new Map([["property", property()]]));
    expect(rendered.title).toBe("Agreement Villa Atlas"); expect(rendered.blocks).toEqual([{ kind: "PARAGRAPH", text: "Retained agreement for Villa Atlas." }]); expect(rendered.privacy).toEqual(["operational"]);
    expect(templateReferences("{{ b }} {{a}} {{b}}")).toEqual(["a", "b"]);
  });
  it.each(["{{property.name}}", "{{constructor}}", "{{__proto__}}", "{{process.exit()}}", "{{#if property}}", "{{property", "property}}", "{{{property}}}"])("rejects executable, nested or malformed token %s", value => {
    expect(documentTemplateDefinitionSchema.safeParse({ ...definition(), title: value }).success).toBe(false);
  });
  it("rejects undeclared, unused and duplicate variables without silently omitting clauses", () => {
    expect(documentTemplateDefinitionSchema.safeParse({ ...definition(), title: "{{unknown}}" }).success).toBe(false);
    expect(documentTemplateDefinitionSchema.safeParse({ ...definition(), variables: [...definition().variables, { key: "unused", kind: "TEXT" }] }).success).toBe(false);
    expect(documentTemplateDefinitionSchema.safeParse({ ...definition(), variables: [...definition().variables, ...definition().variables] }).success).toBe(false);
  });
  it("rejects missing, additional or mismatched native values", () => {
    expect(() => renderDocumentTemplate(definition(), new Map())).toThrow("document_template_binding_unavailable");
    expect(() => renderDocumentTemplate(definition(), new Map([["property", property()], ["extra", property()]]))).toThrow("document_template_binding_unavailable");
    expect(() => renderDocumentTemplate(definition(), new Map([["property", { kind: "INTEGER", value: "2", privacy: ["operational"] }]]))).toThrow("document_template_binding_unavailable");
  });
  it("never reinterprets inserted legal text as a token, HTML, helper or object path", () => {
    const supplied = "{{property}} <script>throw new Error('never execute')</script> $&";
    expect(renderDocumentTemplate(definition(), new Map([["property", property(supplied)]])).blocks[0].text).toBe("Retained agreement for " + supplied + ".");
  });
  it.each(["en", "fr", "ar"] as const)("preserves exact Money beyond the safe-number range in %s", locale => {
    const template = { ...definition(locale), title: "{{amount}}", variables: [{ key: "amount", kind: "MONEY" }], blocks: [{ kind: "PARAGRAPH", text: "{{amount}}" }] }, money = Money.of("9007199254740993.07", "MAD"), before = money.toJSON();
    const rendered = renderDocumentTemplate(template, new Map([["amount", { kind: "MONEY", value: money, privacy: ["operational"] }]]));
    const digits = rendered.title.replace(/[٠-٩]/gu, value => String(value.charCodeAt(0) - 0x660)).replace(/[^0-9]/gu, "");
    expect(digits).toBe("900719925474099307"); expect(rendered.privacy).toEqual(["financial", "operational"]); expect(money.toJSON()).toEqual(before);
  });
  it("formats large integers with BigInt and rejects numeric financial values", () => {
    const template = { ...definition(), title: "{{quantity}}", variables: [{ key: "quantity", kind: "INTEGER" }], blocks: [{ kind: "PARAGRAPH", text: "{{quantity}}" }] };
    expect(renderDocumentTemplate(template, new Map([["quantity", { kind: "INTEGER", value: "9007199254740993123456789", privacy: ["operational"] }]])).title).toBe("9,007,199,254,740,993,123,456,789");
    const forged = new Map([["quantity", { kind: "INTEGER", value: 9007199254740992, privacy: ["operational"] }]]) as unknown as ReadonlyMap<string, DocumentTemplateBinding>;
    expect(() => renderDocumentTemplate(template, forged)).toThrow("document_template_binding_unavailable");
  });
  it("keeps calendar dates independent of a display timezone and rejects impossible dates", () => {
    const template = { ...definition("fr"), title: "{{date}}", variables: [{ key: "date", kind: "DATE" }], blocks: [{ kind: "PARAGRAPH", text: "{{date}}" }] };
    expect(renderDocumentTemplate(template, new Map([["date", { kind: "DATE", value: "2028-02-29", privacy: ["operational"] }]])).title).toContain("29");
    expect(() => renderDocumentTemplate(template, new Map([["date", { kind: "DATE", value: "2027-02-29", privacy: ["operational"] }]]))).toThrow("document_template_binding_unavailable");
  });
  it("requires authored EN/FR variants and never substitutes a missing Arabic version", () => {
    const variants = [definition("en"), definition("fr")]; expect(documentTemplateVariantsSchema.parse(variants)).toHaveLength(2);
    expect(selectDocumentTemplateVariant(variants, "fr").locale).toBe("fr"); expect(() => selectDocumentTemplateVariant(variants, "ar")).toThrow("document_template_binding_unavailable");
    expect(documentTemplateVariantsSchema.safeParse([definition("en"), definition("en")]).success).toBe(false);
    expect(documentTemplateVariantsSchema.safeParse([definition("en"), { ...definition("fr"), templateKey: "other_agreement" }]).success).toBe(false);
    expect(documentTemplateVariantsSchema.safeParse([definition("en"), { ...definition("fr"), variables: [{ key: "property", kind: "MONEY" }] }]).success).toBe(false);
  });
  it("retains classification from every native value and does not mutate source bindings", () => {
    const template = { ...definition(), title: "{{property}} {{person}}", variables: [...definition().variables, { key: "person", kind: "TEXT" }], blocks: definition().blocks }, bindings = new Map<string, DocumentTemplateBinding>([["property", property()], ["person", { kind: "TEXT", value: "Original person", privacy: ["sensitive"] }]]), before = [...bindings];
    expect(renderDocumentTemplate(template, bindings).privacy).toEqual(["operational", "sensitive"]); expect([...bindings]).toEqual(before);
  });
  it("rejects blank and control-only native text instead of emitting an empty contractual value", () => {
    for (const value of [" ", "\n", "\u0000"]) expect(() => renderDocumentTemplate(definition(), new Map([["property", property(value)]]))).toThrow("document_template_binding_unavailable");
  });
  it("round-trips authored UTF-8 and preserves exact legal text without rewriting the definition", () => {
    const original = { ...definition("ar"), title: "اتفاقية {{property}}", blocks: [{ kind: "PARAGRAPH", text: "  النص الأصلي {{property}}\nDeuxième ligne.  " }] }, before = structuredClone(original);
    expect(decodeDocumentTemplate(encodeDocumentTemplate(original))).toEqual(original); expect(original).toEqual(before);
  });
  it("rejects malformed JSON, invalid UTF-8 and oversized definition bytes", () => {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode("{broken}"), new Uint8Array([0xc3, 0x28]), new Uint8Array(1024 * 1024 + 1)]) expect(() => decodeDocumentTemplate(bytes)).toThrow("document_template_invalid");
  });
  it("rejects caller-invented ownership, authority and unknown format versions in definition bytes", () => {
    for (const extra of [{ organizationId: "foreign-organization" }, { authorizationCap: {} }, { schemaVersion: 2 }]) expect(() => decodeDocumentTemplate(new TextEncoder().encode(JSON.stringify({ ...definition(), ...extra })))).toThrow("document_template_invalid");
  });
  it("preserves arbitrary admitted text literally and never performs recursive interpolation", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-zA-Z0-9 $&{}<>_]{1,100}$/u).filter(value => value.trim().length > 0), value => {
      const rendered = renderDocumentTemplate(definition(), new Map([["property", property(value)]]));
      expect(rendered.title).toBe("Agreement " + value); expect(rendered.blocks[0].text).toBe("Retained agreement for " + value + ".");
    }));
  });
});
