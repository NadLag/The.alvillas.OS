import { randomUUID } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { accountantExportColumns, AccountantExportConfigurationError } from "@/modules/finance/domain/accountant-export";
import { AccountantPdfRenderer, accountantPdfTemplate } from "@/modules/finance/infrastructure/accountant-pdf-renderer";
import type { AccountantExportLabels } from "@/modules/finance/infrastructure/accountant-tabular-renderer";
import type { PdfRenderer } from "@/platform/providers";

const source = () => ({ organizationId: randomUUID(), kind: "TRANSACTIONS", currency: "MAD", fromOn: "2031-05-01", toOn: "2031-05-31", timezone: "Africa/Casablanca",
  policy: { id: randomUUID(), version: 2 }, sourceFingerprint: "a".repeat(64), generatedAt: "2031-06-01T00:00:00Z", columns: ["postingId", "amount", "description"],
  rows: [{ identity: randomUUID(), cells: { postingId: { kind: "IDENTIFIER", value: randomUUID() }, amount: { kind: "MONEY", value: "-9007199254740993.07" },
    description: { kind: "TEXT", value: "Original écritures / vérification" } } }] });
const labels: AccountantExportLabels = { title: "Écritures financières originales", headers: Object.fromEntries(accountantExportColumns.map(key => [key, key])) as AccountantExportLabels["headers"],
  metadata: { recordType: "recordType", report: "report", fromOn: "fromOn", toOn: "toOn", currency: "currency", timezone: "timezone", policyId: "policyId", policyVersion: "policyVersion", sourceFingerprint: "sourceFingerprint", generatedAt: "generatedAt", propertyId: "propertyId", ownerId: "ownerId", accountId: "accountId" },
  metadataRow: "metadata", sourceRow: "source", metadataSheet: "Metadata", dataSheet: "Original entries" };
describe("actual server-side accountant PDFs", () => {
  it.each(["en", "fr"] as const)("embeds local fonts and retains exact native text and money in a real %s PDF without network font requests", async locale => {
    const original = source(), before = structuredClone(original), nativeFetch = globalThis.fetch, externalRequests = vi.fn();
    const transport = vi.fn<typeof fetch>((request, options) => {
      const target = request instanceof Request ? request.url : String(request);
      if (!target.startsWith("data:")) { externalRequests(target); return Promise.reject(Error("No external document or font requests allowed")); }
      // Yoga's bundled in-memory WebAssembly uses the fetch API for a data URI.
      return nativeFetch(request, options);
    });
    vi.stubGlobal("fetch", transport);
    let text = "";
    try {
      const bytes = await new AccountantPdfRenderer().render({ template: accountantPdfTemplate, data: { source: original, labels, maxRows: 100 }, locale });
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(externalRequests).not.toHaveBeenCalled();
      expect(transport.mock.calls.every(([url]) => (url instanceof Request ? url.url : String(url)).startsWith("data:"))).toBe(true);
      const task = getDocument({ data: bytes, useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true }), pdf = await task.promise;
      try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const content = await (await pdf.getPage(pageNumber)).getTextContent();
          text += content.items.map(item => "str" in item ? item.str : "").join("\n");
        }
      } finally { await task.destroy(); }
      expect(text).toContain("-9007199254740993.07"); expect(text).toContain(original.policy.id); expect(text).toContain(original.sourceFingerprint);
      expect(text).toContain(original.rows[0].cells.postingId.value); expect(text).toContain("Original écritures / vérification");
      expect(externalRequests).not.toHaveBeenCalled(); expect(original).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
  });
  it("requires a real Arabic-capable provider for Arabic documents and Arabic original text in an EN/FR document", async () => {
    const original = source(), plain = { template: accountantPdfTemplate, data: { source: original, labels, maxRows: 100 }, locale: "ar" as const };
    await expect(new AccountantPdfRenderer().render(plain)).rejects.toThrow(AccountantExportConfigurationError);
    original.rows[0].cells.description.value = "حركة مالية أصلية";
    await expect(new AccountantPdfRenderer().render({ ...plain, locale: "fr" })).rejects.toThrow(AccountantExportConfigurationError);
    const render = vi.fn<PdfRenderer["render"]>(() => Promise.resolve(new Uint8Array([37, 80, 68, 70, 45])));
    const bytes = await new AccountantPdfRenderer({ render }).render({ ...plain, locale: "fr" });
    expect([...bytes]).toEqual([37, 80, 68, 70, 45]); expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0][0].data.source).toMatchObject({ rows: [{ cells: { description: { value: "حركة مالية أصلية" } } }] });
  });
});
