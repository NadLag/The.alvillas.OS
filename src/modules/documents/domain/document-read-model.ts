import { z } from "zod";
import { documentSourceReferenceSchema } from "./document-command";
import { documentContentTypes, documentPrivacyTags } from "./document-policy";

export const documentVersionItemSchema = z.object({ id: z.uuid(), documentId: z.uuid(), number: z.number().int().positive(), title: z.string(), fileName: z.string(),
  contentType: z.enum(documentContentTypes), fileSize: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  supersedesId: z.uuid().nullable(), supersededById: z.uuid().nullable(), effectiveFrom: z.iso.datetime().nullable(), createdAt: z.iso.datetime() }).strict();
export const documentItemSchema = z.object({ id: z.uuid(), source: documentSourceReferenceSchema, typeKey: z.string(), kind: z.enum(["FILE", "TEMPLATE", "INSTANCE"]),
  locale: z.enum(["en", "fr", "ar"]), title: z.string(), privacy: z.array(z.enum(documentPrivacyTags)), revision: z.string().regex(/^[1-9]\d*$/u),
  createdAt: z.iso.datetime(), archivedAt: z.iso.datetime().nullable() }).strict();
export const documentHistorySchema = z.object({ document: documentItemSchema, versions: z.array(documentVersionItemSchema), next: z.number().int().positive().nullable() }).strict();
export const documentUploadAdmissionSchema = z.object({ id: z.uuid(), documentId: z.uuid(), complete: z.boolean(), version: documentVersionItemSchema.nullable() }).strict();
