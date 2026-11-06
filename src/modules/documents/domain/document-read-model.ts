import { z } from "zod";
import { documentSourceReferenceSchema } from "./document-command";
import { documentContentTypes, documentPrivacyTags } from "./document-policy";
import { documentUploadPartsSchema } from "./document-upload-parts";

export const documentVersionItemSchema = z.object({ id: z.uuid(), documentId: z.uuid(), number: z.number().int().positive(), title: z.string(), fileName: z.string(),
  contentType: z.enum(documentContentTypes), fileSize: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  supersedesId: z.uuid().nullable(), supersededById: z.uuid().nullable(), effectiveFrom: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), createdBy: z.uuid(), reason: z.string() }).strict();
export const documentItemSchema = z.object({ id: z.uuid(), source: documentSourceReferenceSchema, typeKey: z.string(), kind: z.enum(["FILE", "TEMPLATE", "INSTANCE"]),
  locale: z.enum(["en", "fr", "ar"]), title: z.string(), privacy: z.array(z.enum(documentPrivacyTags)), revision: z.string().regex(/^[1-9]\d*$/u),
  createdAt: z.iso.datetime(), archivedAt: z.iso.datetime().nullable(), templateKey: z.string().nullable() }).strict();
export const documentHistorySchema = z.object({ document: documentItemSchema, versions: z.array(documentVersionItemSchema), next: z.number().int().positive().nullable() }).strict();
export const documentUploadAdmissionSchema = z.object({ recorded: z.literal(true), id: z.uuid(), documentId: z.uuid(), idempotencyKey: z.uuid(), state: z.enum(["ADMITTED","COMPLETE","SUPERSEDED"]), complete: z.boolean(), version: documentVersionItemSchema.nullable(),
  expected: z.object({ fileName: z.string(), contentType: z.enum(documentContentTypes), fileSize: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),parts:documentUploadPartsSchema.nullable() }).strict() }).strict().superRefine((value,ctx)=>{
    if(value.complete!==(value.state==="COMPLETE")||Boolean(value.version)!==value.complete)ctx.addIssue({code:"custom",message:"consistent_original_admission_state_required"});
    if(value.version&&(value.version.documentId!==value.documentId||value.version.fileName!==value.expected.fileName||value.version.contentType!==value.expected.contentType||value.version.fileSize!==value.expected.fileSize||value.version.sha256!==value.expected.sha256))ctx.addIssue({code:"custom",message:"exact_original_admitted_file_required"});
  });
export const documentUploadRecoverySchema = z.discriminatedUnion("recorded",[documentUploadAdmissionSchema,
  z.object({ recorded: z.literal(false), id: z.null(), documentId: z.null(), idempotencyKey: z.uuid(), complete: z.literal(false), version: z.null(), expected: z.null() }).strict()]);
export const documentPartReceiptSchema=z.object({admissionId:z.uuid(),idempotencyKey:z.uuid(),index:z.number().int().min(0),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const documentSourceChoicesSchema = z.object({ items: z.array(z.object({ source: documentSourceReferenceSchema, label: z.string() }).strict()), next: z.string().nullable() }).strict();
export const documentSourceWorkspaceSchema = z.object({ source: documentSourceReferenceSchema, sourceLabel: z.string(), policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), items: z.array(documentItemSchema), next: z.string().nullable(),
  types: z.array(z.object({ key: z.string(), labels: z.object({ en: z.string(), fr: z.string(), ar: z.string() }), contentTypes: z.array(z.enum(documentContentTypes)), maxBytes: z.number().int().positive() }).strict()) }).strict();
