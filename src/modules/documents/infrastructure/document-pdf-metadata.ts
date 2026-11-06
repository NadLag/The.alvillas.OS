import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { signatureMaximumPdfBytes } from "@/platform/providers/signature-contract";
import { DocumentConflictError } from "../domain/document-command";

export async function documentPdfPageCount(bytes: Uint8Array): Promise<number> {
  if (bytes.length < 8 || bytes.length > signatureMaximumPdfBytes) throw new DocumentConflictError();
  const task = getDocument({ data: new Uint8Array(bytes), enableXfa: false, useSystemFonts: false, useWorkerFetch: false, useWasm: false, disableFontFace: true, verbosity: 0 });
  try { const pdf = await task.promise; if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new DocumentConflictError(); return pdf.numPages; }
  catch { throw new DocumentConflictError(); }
  finally { await task.destroy(); }
}
