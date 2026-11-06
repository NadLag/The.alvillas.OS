import { z } from "zod";
import { documentPrivacyTags } from "./document-policy";
import { documentTemplateMaximumBytes } from "./document-template-format";

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !/\p{Cc}/u.test(value.replaceAll("\t", "").replaceAll("\r", "").replaceAll("\n", "")));
export const documentPdfTemplate = "documents.authored-instance.v1";
export const renderedDocumentSchema = z.object({
  templateKey: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u), locale: z.enum(["en", "fr", "ar"]),
  title: text(documentTemplateMaximumBytes),
  blocks: z.array(z.object({ kind: z.enum(["HEADING", "PARAGRAPH", "BULLET"]), text: text(documentTemplateMaximumBytes) }).strict()).nonempty().max(200),
  privacy: z.array(z.enum(documentPrivacyTags)).max(3).refine(values => new Set(values).size === values.length)
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= documentTemplateMaximumBytes);
export const documentPdfInputSchema = z.object({ source: renderedDocumentSchema, provenance: z.object({
  templateVersionId: z.uuid(), templateSha256: z.string().regex(/^[a-f0-9]{64}$/u), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict(), maximumBytes: z.number().int().min(1).max(10 * 1024 * 1024) }).strict();
export class DocumentPdfConfigurationError extends Error { constructor() { super("document_pdf_unavailable"); } }

/** A provider result remains untrusted until its bounded PDF envelope is checked. */
export function validateGeneratedPdf(raw: Uint8Array, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 10 * 1024 * 1024 ||
    !(raw instanceof Uint8Array) || raw.length < 12 || raw.length > maximumBytes ||
    !new TextDecoder().decode(raw.subarray(0, 16)).match(/^%PDF-(?:1\.[0-9]|2\.0)(?:\r?\n|\r)/u) ||
    !/%%EOF\s*$/u.test(new TextDecoder().decode(raw.subarray(Math.max(0, raw.length - 1024))))) throw new DocumentPdfConfigurationError();
  return new Uint8Array(raw);
}
