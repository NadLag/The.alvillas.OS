import { z } from "zod";

export const financialAttachmentKinds = ["RECEIPT", "INVOICE"] as const;
export const financialAttachmentContentTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
const id = z.uuid().transform(value => value.toLowerCase());
const extensions = { "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] } as const;
export const financialAttachmentIntentSchema = z.object({ transactionId: id, idempotencyKey: id, kind: z.enum(financialAttachmentKinds),
  fileName: z.string().trim().min(1).max(180).refine(value => !/[\p{Cc}\\/]/u.test(value)).transform(value => value.normalize("NFC")),
  contentType: z.enum(financialAttachmentContentTypes), fileSize: z.number().int().positive().max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase()), supersedesId: id.nullable().default(null),
  reason: z.string().trim().min(6).max(1000) }).strict().refine(input => {
    const extension = input.fileName.split(".").at(-1)?.toLowerCase();
    return extension !== undefined && (extensions[input.contentType] as readonly string[]).includes(extension);
  }, { path: ["fileName"], message: "file_extension_must_match_content_type" });
export type FinancialAttachmentIntent = z.infer<typeof financialAttachmentIntentSchema>;
export const financialAttachmentReferenceSchema = z.object({ id }).strict();
export const financialAttachmentListSchema = z.object({ transactionId: id, before: id.optional() }).strict();

export class FinancialAttachmentAccessError extends Error { constructor() { super("financial_attachment_forbidden"); } }
export class FinancialAttachmentConfigurationError extends Error { constructor() { super("financial_attachment_configuration_unavailable"); } }
export class FinancialAttachmentSourceError extends Error { constructor() { super("financial_attachment_source_unavailable"); } }
export class FinancialAttachmentConflictError extends Error { constructor() { super("financial_attachment_conflict"); } }
export class FinancialAttachmentValidationError extends Error { constructor() { super("financial_attachment_invalid_file"); } }
export class FinancialAttachmentStorageError extends Error { constructor() { super("financial_attachment_storage_unavailable"); } }
export class FinancialAttachmentRateLimitError extends Error { constructor(readonly resetAt: Date) { super("financial_attachment_rate_limited"); } }

/** The server validates the original body independently of its declared MIME type and filename. */
export function validateFinancialAttachmentBytes(bytes: Uint8Array, expected: Pick<FinancialAttachmentIntent, "contentType" | "fileSize">): void {
  if (bytes.length !== expected.fileSize) throw new FinancialAttachmentValidationError();
  const starts = (signature: readonly number[]) => signature.every((value, index) => bytes[index] === value);
  const valid = expected.contentType === "application/pdf" ? starts([37, 80, 68, 70, 45]) && new TextDecoder("latin1").decode(bytes.slice(-1024)).includes("%%EOF")
    : expected.contentType === "image/png" ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : expected.contentType === "image/jpeg" ? starts([255, 216, 255]) && bytes.at(-2) === 255 && bytes.at(-1) === 217
    : starts([82, 73, 70, 70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  if (!valid) throw new FinancialAttachmentValidationError();
}

export function financialAttachmentEncryptionContext(input: { organizationId: string; transactionId: string; id: string; contentType: string; fileSize: number; sha256: string }): string {
  return JSON.stringify(["financial-attachment-v1", input.organizationId, input.transactionId, input.id, input.contentType, input.fileSize, input.sha256]);
}
