import { createElement } from "react";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { documentPdfPageCount } from "@/modules/documents/infrastructure/document-pdf-metadata";
import { signatureMaximumPdfBytes } from "@/platform/providers/signature-contract";

describe("actual archived PDF page metadata", () => {
  it("reads every actual page while retaining the exact original PDF bytes", async () => {
    const bytes = await renderToBuffer(createElement(Document, {}, ...Array.from({ length: 3 }, (_, index) => createElement(Page, { key: index, size: "A4" }, createElement(Text, {}, "Actual original signing page " + (index + 1))))));
    const original = Buffer.from(bytes); expect(await documentPdfPageCount(bytes)).toBe(3); expect(bytes).toEqual(original);
  });
  it("rejects an apparently PDF-prefixed malformed body without exposing its private content", async () => {
    await expect(documentPdfPageCount(Buffer.from("%PDF-1.7\nPRIVATE-INVALID-LEGAL-CLAUSE\n%%EOF"))).rejects.toThrow(/^document_source_changed$/u);
  });
  it("rejects missing or oversized bytes before starting a PDF parser", async () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(signatureMaximumPdfBytes + 1)]) await expect(documentPdfPageCount(bytes)).rejects.toThrow(/^document_source_changed$/u);
  });
});
