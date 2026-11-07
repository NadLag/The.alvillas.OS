import { z } from "zod";
import { financialAttachmentKinds, financialAttachmentContentTypes } from "./financial-attachment";
import { financialAttachmentUploadMaximumParts } from "./financial-attachment-parts";

export const attachmentTransactionSchema = z.object({ id: z.uuid(), reference: z.string(), occurredAt: z.iso.datetime(),
  amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/u).nullable(), currency: z.string().regex(/^[A-Z]{3}$/u).nullable() }).strict();
export const financialAttachmentItemSchema = z.object({ id: z.uuid(), rootId: z.uuid(), transactionId: z.uuid(), version: z.number().int().positive(),
  kind: z.enum(financialAttachmentKinds), fileName: z.string(), contentType: z.enum(financialAttachmentContentTypes), fileSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), reason: z.string(), createdAt: z.iso.datetime(), supersedesId: z.uuid().nullable(), supersededById: z.uuid().nullable() }).strict();
export const financialAttachmentHistorySchema = z.object({ transaction: attachmentTransactionSchema, items: z.array(financialAttachmentItemSchema).max(30),
  next: z.uuid().nullable(), contentTypes: z.array(z.enum(financialAttachmentContentTypes)), maxBytes: z.number().int().positive() }).strict();
export const financialAttachmentEditorSchema = z.object({ items: z.array(attachmentTransactionSchema).max(30), next: z.uuid().nullable() }).strict();
export const financialAttachmentAdmissionResultSchema = z.object({ id: z.uuid(), expiresAt: z.iso.datetime(), attached: z.boolean() }).strict();
export const financialAttachmentPartReceiptSchema=z.object({id:z.uuid(),idempotencyKey:z.uuid(),index:z.number().int().min(0).max(financialAttachmentUploadMaximumParts-1),sha256:z.string().regex(/^[a-f0-9]{64}$/u),attached:z.boolean()}).strict();
export type FinancialAttachmentHistory = z.infer<typeof financialAttachmentHistorySchema>;
export type FinancialAttachmentItem = z.infer<typeof financialAttachmentItemSchema>;
export type AttachmentTransaction = z.infer<typeof attachmentTransactionSchema>;
