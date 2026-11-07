import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { signatureMaximumPdfBytes } from "@/platform/providers/signature-contract";
import { DocumentConflictError } from "../domain/document-command";

async function withDocumentPdf<T>(bytes: Uint8Array, work: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  if (bytes.length < 8 || bytes.length > signatureMaximumPdfBytes) throw new DocumentConflictError();
  const task = getDocument({ data: new Uint8Array(bytes), enableXfa: false, useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true, verbosity: 0 });
  try { const pdf = await task.promise; if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new DocumentConflictError(); return await work(pdf); }
  catch { throw new DocumentConflictError(); }
  finally { await task.destroy(); }
}
export async function documentPdfPageCount(bytes: Uint8Array): Promise<number> { return withDocumentPdf(bytes, pdf => Promise.resolve(pdf.numPages)); }

/** Provider completion cannot substitute another contract or return its unsigned original. */
export async function assertSignedPdfPreservesOriginal(original: Uint8Array, signed: Uint8Array) {
  if (Buffer.from(original).equals(Buffer.from(signed))) throw new DocumentConflictError();
  return withDocumentPdf(original, before => withDocumentPdf(signed, async after => {
    if (after.numPages < before.numPages) throw new DocumentConflictError();
    const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
    for (let page = 1; page <= before.numPages; page++) {
      const source = await before.getPage(page), completed = await after.getPage(page), originalBox = source.getViewport({ scale: 1, rotation: 0 }), signedBox = completed.getViewport({ scale: 1, rotation: 0 });
      if (originalBox.width !== signedBox.width || originalBox.height !== signedBox.height) throw new DocumentConflictError();
      const text = normalize((await source.getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ")), observed = normalize((await completed.getTextContent()).items.map(item => "str" in item ? item.str : "").join(" "));
      if (!text || !observed.includes(text)) throw new DocumentConflictError();
    }
  }));
}
