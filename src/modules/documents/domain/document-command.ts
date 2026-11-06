import { z } from "zod";
import { documentContentTypes, documentSourceKinds } from "./document-policy";

export const documentSourceReferenceSchema = z.object({ kind: z.enum(documentSourceKinds), id: z.uuid() }).strict();
export const documentFileNameSchema = z.string().min(1).max(240).refine(value => value === value.trim() && !/[\\/\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value), "invalid_document_file_name");
export const documentUploadReviewInput = z.object({ documentId: z.uuid().nullable(), source: documentSourceReferenceSchema,
  typeKey: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u), kind: z.enum(["FILE", "TEMPLATE"]), locale: z.enum(["en", "fr", "ar"]), title: z.string().trim().min(1).max(500),
  fileName: documentFileNameSchema, contentType: z.enum(documentContentTypes), fileSize: z.number().int().min(1).max(10 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  supersedesId: z.uuid().nullable(), effectiveFrom: z.iso.datetime({ offset: true }).nullable(), templateKey: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u).nullable()
}).strict().superRefine((value, ctx) => {
  if (!value.documentId && value.supersedesId) ctx.addIssue({ code: "custom", message: "original_document_required" });
  if ((value.kind === "TEMPLATE") !== Boolean(value.templateKey)) ctx.addIssue({ code: "custom", message: "explicit_template_identity_required" });
});
export const documentUploadInput = documentUploadReviewInput.safeExtend({ idempotencyKey: z.uuid(), reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), reason: z.string().trim().min(8).max(1000) });
export const documentRecoveryInput = z.object({ idempotencyKey: z.uuid() }).strict();
export const documentReferenceInput = z.object({ documentId: z.uuid() }).strict();
export const documentVersionReferenceInput = z.object({ versionId: z.uuid() }).strict();
export const documentListInput = z.object({ source: documentSourceReferenceSchema, typeKey: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u).optional(),
  locale: z.enum(["en", "fr", "ar"]).optional(), cursor: z.string().max(6000).optional() }).strict();
export class DocumentAccessError extends Error { constructor() { super("document_unavailable"); } }
export class DocumentConfigurationError extends Error { constructor() { super("document_configuration_unavailable"); } }
export class DocumentConflictError extends Error { constructor() { super("document_source_changed"); } }
export class DocumentStorageError extends Error { constructor() { super("document_storage_unavailable"); } }
