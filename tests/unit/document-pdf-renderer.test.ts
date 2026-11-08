import { randomUUID } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "@/platform/money/money";
import { formatCurrency } from "@/i18n/format";
import type { PdfRenderer } from "@/platform/providers";
import { renderDocumentTemplate, type DocumentTemplateBinding } from "@/modules/documents/domain/document-template";
import { documentPdfTemplate, DocumentPdfConfigurationError, validateGeneratedPdf } from "@/modules/documents/domain/document-pdf";
import { DocumentPdfRenderer, configuredDocumentPdfRenderer } from "@/modules/documents/infrastructure/document-pdf-renderer";

const provenance = () => ({ templateVersionId: randomUUID(), templateSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
const payload = (locale: "en" | "fr" | "ar" = "en") => ({ source: { templateKey: "original_agreement", locale, title: "Original authored agreement",
  blocks: [{ kind: "PARAGRAPH", text: "Original source text" }], privacy: ["operational"] }, provenance: provenance(), maximumBytes: 1048576 });
async function extract(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true }), pdf = await task.promise;
  try {
    const text: string[] = [], annotations: unknown[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const actual = await pdf.getPage(page), content = await actual.getTextContent();
      const pageAnnotations: unknown[] = await actual.getAnnotations();
      text.push(content.items.map(item => "str" in item ? item.str : "").join("\n")); annotations.push(...pageAnnotations);
    }
    return { pages: pdf.numPages, text: text.join("\n"), annotations, metadata: await pdf.getMetadata() };
  } finally { await task.destroy(); }
}
afterEach(() => vi.unstubAllGlobals());

describe("actual authored document PDF rendering", () => {
  it("retains exact uppercase clauses after successive native contact and accented French documents",async()=>{
    const renderer=new DocumentPdfRenderer();for(const locale of["en","fr"]as const){const input=payload(locale),contact="Native owner "+randomUUID()+" LongContact".repeat(9);input.source.title=contact;input.source.blocks=[{kind:"PARAGRAPH",text:contact+" / "+(locale==="en"?"Actual assessment":"Évaluation réelle")}];await extract(await renderer.render({template:documentPdfTemplate,locale,data:input}));}
    const marker="PRIVATE-GENERATED-CLAUSE-96c4a75ad888",input=payload();input.source.title="Agreement PWA villa";input.source.blocks=[{kind:"PARAGRAPH",text:marker+" PWA villa"}];const actual=await extract(await renderer.render({template:documentPdfTemplate,locale:"en",data:input}));expect(actual.text).toContain(marker);expect(actual.text).toContain("PWA villa");
  });
  it("retains exact clauses and Money in concurrent documents containing accents before uppercase text",async()=>{
    const money=Money.of("9007199254740993.07","MAD"),documents=await Promise.all((["fr","en","fr"]as const).map(async(locale,index)=>{const input=payload(locale),marker="EXACT-RETAINED-CLAUSE-"+index;input.source.blocks=[{kind:"PARAGRAPH",text:"Évaluation réelle"},{kind:"PARAGRAPH",text:marker+" "+formatCurrency(locale,money)}];return{marker,locale,actual:await extract(await new DocumentPdfRenderer().render({template:documentPdfTemplate,locale,data:input}))};}));for(const document of documents){expect(document.actual.text).toContain(document.marker);expect(document.actual.text.replace(/\s/gu,"")).toContain(formatCurrency(document.locale,money).replace(/\s/gu,""));}expect(money.toJSON()).toEqual({amount:"9007199254740993.07",currency:"MAD"});
  });
  it.each(["en", "fr"] as const)("renders %s original clauses and exact classified Money without remote assets, markup or recursive tokens", async locale => {
    const money = Money.of("9007199254740993.07", "MAD"), template = { schemaVersion: 1, templateKey: "original_agreement", locale, title: "Convention {{property}}", variables: [{ key: "property", kind: "TEXT" }, { key: "amount", kind: "MONEY" }], blocks: [
      { kind: "HEADING", text: "Écritures et vérification" }, { kind: "PARAGRAPH", text: "Original {{property}}\n{{amount}}" }, { kind: "BULLET", text: "Clause conservée {{property}}" }
    ] }, bindings = new Map<string, DocumentTemplateBinding>([["property", { kind: "TEXT", value: "<script>literal</script> {{amount}}", privacy: ["operational"] }], ["amount", { kind: "MONEY", value: money, privacy: ["financial"] }]]), source = renderDocumentTemplate(template, bindings), original = structuredClone(source), savedProvenance = provenance(), nativeFetch = globalThis.fetch, network = vi.fn();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((request, init) => {
      const address = request instanceof Request ? request.url : String(request);
      if (!address.startsWith("data:")) { network(address); throw Error("Remote document assets are forbidden"); }
      return nativeFetch(request, init);
    }));
    const bytes = await new DocumentPdfRenderer().render({ template: documentPdfTemplate, locale, data: { source, provenance: savedProvenance, maximumBytes: 1048576 } }), actual = await extract(bytes);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-"); expect(actual.text).toContain("Écritures et vérification");
    expect(actual.text).toContain("<script>literal</script> {{amount}}");
    expect(actual.text.replace(/\s/gu, "")).toContain(formatCurrency(locale, money).replace(/\s/gu, ""));
    expect(actual.text.replace(/\s/gu, "")).not.toContain(formatCurrency(locale, Money.of("9007199254740992.00", "MAD")).replace(/\s/gu, ""));
    expect(actual.annotations).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(source).toEqual(original); expect(source.privacy).toEqual(["financial", "operational"]); expect(money.toJSON()).toEqual({ amount: "9007199254740993.07", currency: "MAD" });
    expect(JSON.stringify(actual.metadata.info)).toContain(savedProvenance.templateVersionId); expect(JSON.stringify(actual.metadata.info)).toContain(savedProvenance.sourceFingerprint);
  });
  it("paginates all original clauses instead of clipping an oversized single page", async () => {
    const input = payload("fr"); input.source.blocks = Array.from({ length: 120 }, (_, index) => ({ kind: "PARAGRAPH", text: "Original clause " + index + ". " + "Texte original conservé pour vérification. ".repeat(12) }));
    const actual = await extract(await new DocumentPdfRenderer().render({ template: documentPdfTemplate, locale: "fr", data: input }));
    expect(actual.pages).toBeGreaterThan(2); for (let index = 0; index < 120; index++) expect(actual.text).toContain("Original clause " + index + ".");
  });
  it("requires the exact renderer, locale and native provenance before rendering", async () => {
    const renderer = new DocumentPdfRenderer(), input = payload();
    await expect(renderer.render({ template: "other.renderer", locale: "en", data: input })).rejects.toThrow(DocumentPdfConfigurationError);
    await expect(renderer.render({ template: documentPdfTemplate, locale: "fr", data: input })).rejects.toThrow(DocumentPdfConfigurationError);
    await expect(renderer.render({ template: documentPdfTemplate, locale: "en", data: { ...input, provenance: {} } })).rejects.toThrow(DocumentPdfConfigurationError);
    await expect(renderer.render({ template: documentPdfTemplate, locale: "en", data: { ...input, source: { ...input.source, remoteImage: "https://example.test/private" } } })).rejects.toThrow(DocumentPdfConfigurationError);
  });
  it("rejects a native PDF exceeding the actual configured archive allowance", async () => {
    await expect(new DocumentPdfRenderer().render({ template: documentPdfTemplate, locale: "en", data: { ...payload(), maximumBytes: 12 } })).rejects.toThrow(DocumentPdfConfigurationError);
  });
  it("requires an Arabic-capable provider for Arabic locale and Arabic original values in EN/FR", async () => {
    const renderer = new DocumentPdfRenderer(), input = payload("ar");
    await expect(renderer.render({ template: documentPdfTemplate, locale: "ar", data: input })).rejects.toThrow(DocumentPdfConfigurationError);
    const french = payload("fr"); french.source.blocks[0].text = "النص الأصلي";
    await expect(renderer.render({ template: documentPdfTemplate, locale: "fr", data: french })).rejects.toThrow(DocumentPdfConfigurationError);
  });
  it("passes original Arabic text, exact locale and immutable provenance to the configured provider boundary", async () => {
    const native = await new DocumentPdfRenderer().render({ template: documentPdfTemplate, locale: "en", data: payload() }), input = payload("ar"); input.source.title = "الاتفاقية الأصلية";
    const before = structuredClone(input), render = vi.fn<PdfRenderer["render"]>(() => Promise.resolve(native)), actual = await new DocumentPdfRenderer({ render }).render({ template: documentPdfTemplate, locale: "ar", data: input });
    expect(actual).toEqual(native); expect(render).toHaveBeenCalledExactlyOnceWith({ template: documentPdfTemplate, locale: "ar", data: input }); expect(input).toEqual(before);
  });
  it("sanitizes provider errors and rejects non-PDF or truncated provider bytes", async () => {
    const input = { template: documentPdfTemplate, locale: "ar" as const, data: payload("ar") };
    const rejected = new DocumentPdfRenderer({ render: () => Promise.reject(Error("private provider diagnostic")) });
    await expect(rejected.render(input)).rejects.toThrow(/^document_pdf_unavailable$/u);
    for (const body of ["<html>private login</html>", "%PDF-1.7\ntruncated", "%PDF-1.7\n%%EOF\ntrailing script"]) {
      await expect(new DocumentPdfRenderer({ render: () => Promise.resolve(new TextEncoder().encode(body)) }).render(input)).rejects.toThrow(DocumentPdfConfigurationError);
    }
  });
  it("bounds an unknown-length HTTP provider stream and cancels the remaining body", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(600)); }, cancel: cancelled });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(stream, { headers: { "content-type": "application/pdf" } }))));
    const renderer = configuredDocumentPdfRenderer({ PDF_RENDERER_ENDPOINT: "https://pdf.example.test/render", PDF_RENDERER_TOKEN: "owned-provider-fixture" });
    await expect(renderer.render({ template: documentPdfTemplate, locale: "ar", data: { ...payload("ar"), maximumBytes: 1024 } })).rejects.toThrow(/^document_pdf_unavailable$/u); expect(cancelled).toHaveBeenCalledOnce();
  });
  it("rejects an HTTP protection page before buffering or interpreting provider content", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(stream, { status: 403, headers: { "content-type": "text/html" } }))));
    const renderer = configuredDocumentPdfRenderer({ PDF_RENDERER_ENDPOINT: "https://pdf.example.test/render", PDF_RENDERER_TOKEN: "owned-provider-fixture" });
    await expect(renderer.render({ template: documentPdfTemplate, locale: "ar", data: payload("ar") })).rejects.toThrow(/^document_pdf_unavailable$/u); expect(cancelled).toHaveBeenCalledOnce();
  });
  it("captures provider result bytes and accepts bounded PDF 1.x and 2.0 envelopes", () => {
    for (const version of ["1.7", "2.0"]) {
      const bytes = new TextEncoder().encode("%PDF-" + version + "\nowned envelope\n%%EOF\n"), captured = validateGeneratedPdf(bytes, 1024); bytes.fill(0); expect(new TextDecoder().decode(captured)).toContain("owned envelope");
    }
  });
  it("stops repeated-variable amplification before constructing an unbounded rendered document", () => {
    const definition = { schemaVersion: 1, templateKey: "bounded_original", locale: "en", title: "{{text}}", variables: [{ key: "text", kind: "TEXT" }], blocks: [{ kind: "PARAGRAPH", text: "{{text}}".repeat(100) }] };
    expect(() => renderDocumentTemplate(definition, new Map([["text", { kind: "TEXT", value: "a".repeat(20000), privacy: ["operational"] }]]))).toThrow("document_template_binding_unavailable");
  });
  it("bounds aggregate UTF-8 across blocks rather than counting characters or each block separately", () => {
    const definition = { schemaVersion: 1, templateKey: "bounded_original", locale: "fr", title: "{{text}}", variables: [{ key: "text", kind: "TEXT" }], blocks: Array.from({ length: 28 }, () => ({ kind: "PARAGRAPH", text: "{{text}}" })) };
    expect(() => renderDocumentTemplate(definition, new Map([["text", { kind: "TEXT", value: "é".repeat(20000), privacy: ["operational"] }]]))).toThrow("document_template_binding_unavailable");
  });
});
