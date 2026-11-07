import { z } from "zod";

export const documentExpiryProtocol = "ALVILLAS_DOCUMENT_EXPIRY_V1";
export const documentExpiryDraftSchema = z.object({
  versionId: z.uuid(),
  previousRevisionId: z.uuid().nullable(),
  expiresOn: z.iso.date().nullable()
}).strict();
export const documentExpiryCommandSchema = documentExpiryDraftSchema.extend({
  idempotencyKey: z.uuid(),
  reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.string().trim().min(8).max(1000)
});
export const documentExpiryRecoverySchema = z.object({ idempotencyKey: z.uuid() }).strict();
export const documentExpiryVersionSchema = z.object({ versionId: z.uuid() }).strict();
export const documentExpiryRevisionSchema = z.object({
  id: z.uuid(), versionId: z.uuid(), number: z.number().int().positive(),
  previousRevisionId: z.uuid().nullable(), expiresOn: z.iso.date().nullable(),
  createdAt: z.iso.datetime(), createdBy: z.uuid(), reason: z.string()
}).strict();
export const documentExpiryHistorySchema = z.object({
  versionId: z.uuid(), current: documentExpiryRevisionSchema.nullable(),
  revisions: z.array(documentExpiryRevisionSchema), next: z.number().int().positive().nullable(),
  canEdit: z.boolean()
}).strict();
export const documentExpiryReceiptSchema = z.object({
  recorded: z.literal(true), idempotencyKey: z.uuid(), revision: documentExpiryRevisionSchema
}).strict();
export const documentExpiryRecoveredSchema = z.discriminatedUnion("recorded", [
  documentExpiryReceiptSchema,
  z.object({ recorded: z.literal(false), idempotencyKey: z.uuid(), revision: z.null() }).strict()
]);
