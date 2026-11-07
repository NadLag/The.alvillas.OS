import { z } from "zod";
import { documentRetentionSelectionSchema,documentRetentionTagSchema,documentRetentionTagsSchema } from "./document-retention-policy";

export const documentRetentionProtocol="ALVILLAS_DOCUMENT_RETENTION_V1";
export const documentRetentionDraftSchema=z.object({versionId:z.uuid(),previousRevisionId:z.uuid().nullable(),tagKeys:documentRetentionSelectionSchema}).strict();
export const documentRetentionCommandSchema=documentRetentionDraftSchema.extend({idempotencyKey:z.uuid(),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:z.string().trim().min(8).max(1000)});
export const documentRetentionRecoverySchema=z.object({idempotencyKey:z.uuid()}).strict();
export const documentRetentionHistoryInputSchema=z.object({versionId:z.uuid(),before:z.number().int().positive().optional()}).strict();
export const documentRetentionRevisionSchema=z.object({id:z.uuid(),versionId:z.uuid(),number:z.number().int().positive(),previousRevisionId:z.uuid().nullable(),tags:documentRetentionTagsSchema,createdAt:z.iso.datetime(),createdBy:z.uuid(),reason:z.string()}).strict();
export const documentRetentionHistorySchema=z.object({versionId:z.uuid(),governedVersion:z.object({id:z.uuid(),documentId:z.uuid(),number:z.number().int().positive()}).strict(),current:documentRetentionRevisionSchema.nullable(),revisions:z.array(documentRetentionRevisionSchema).max(10),next:z.number().int().positive().nullable(),canEdit:z.boolean(),configured:z.boolean(),choices:z.array(documentRetentionTagSchema).max(1000)}).strict();
export const documentRetentionReceiptSchema=z.object({recorded:z.literal(true),idempotencyKey:z.uuid(),revision:documentRetentionRevisionSchema}).strict();
export const documentRetentionRecoveredSchema=z.discriminatedUnion("recorded",[documentRetentionReceiptSchema,z.object({recorded:z.literal(false),idempotencyKey:z.uuid(),revision:z.null()}).strict()]);
export const documentRetentionPolicyContextSchema=z.object({versionId:z.uuid(),governedVersionId:z.uuid(),revisionId:z.uuid().nullable(),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),tags:documentRetentionTagsSchema,tagKeys:documentRetentionSelectionSchema,blocksDisposition:z.boolean(),policyReferences:z.array(z.string()),disposition:z.literal("REQUIRES_OWNER_APPROVED_PRIVACY_WORKFLOW")}).strict();
