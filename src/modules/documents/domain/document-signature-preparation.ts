import { z } from "zod";
import { signatureFieldSchema, signatureRecipientRoleSchema, signatureMethodsSchema, signatureSigningOrderSchema, signatureDeliveryOptionsSchema } from "@/platform/providers/signature-contract";
import { documentUploadInput } from "./document-command";
import { nativeSignatureSnapshotSchema } from "./document-signature-command";
import { enabledDocumentSignaturePolicySchema } from "./document-signature-policy";

export const signaturePreparationProtocol = "ALVILLAS_SIGNATURE_PREPARATION_V1";
export const signaturePreparationRequested = "documents.signature.prepare_requested";
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signaturePreparationRecipientSchema = z.object({ recipientId: z.uuid(), role: signatureRecipientRoleSchema, signingOrder: z.number().int().nonnegative(), fields: z.array(signatureFieldSchema).max(200) }).strict();
export const signaturePreparationDraftSchema = z.object({ signatureId: z.uuid(), recipients: z.array(signaturePreparationRecipientSchema).min(1).max(100)
  .refine(values => new Set(values.map(value => value.recipientId)).size === values.length, "original_native_recipient_required") }).strict().superRefine((value, ctx) => {
    if (!value.recipients.some(recipient => recipient.role === "SIGNER") || value.recipients.some(recipient => recipient.role === "SIGNER" && !recipient.fields.some(field => field.type === "SIGNATURE")) ||
      value.recipients.reduce((count, recipient) => count + recipient.fields.length, 0) > 10000) ctx.addIssue({ code: "custom", message: "explicit_signature_fields_required" });
  });
export const signaturePreparationCommandSchema = signaturePreparationDraftSchema.safeExtend({ idempotencyKey: documentUploadInput.shape.idempotencyKey, reviewFingerprint: documentUploadInput.shape.reviewFingerprint, reason: documentUploadInput.shape.reason });
export const signaturePreparationSnapshotSchema = z.object({ protocol: z.literal(signaturePreparationProtocol), schemaVersion: z.literal(1),
  command: signaturePreparationCommandSchema, commandHash: sha, signatureCommandHash: sha, contextFingerprint: sha, contractHash: sha,
  document: nativeSignatureSnapshotSchema.shape.document,
  providerPolicy: z.object({ id: z.uuid(), version: z.number().int().positive(), value: enabledDocumentSignaturePolicySchema, originalValue: z.json() }).strict(),
  providerScopeHash: sha,
  recipients: z.array(z.object({ id: z.uuid(), identityHash: sha, fingerprint: sha }).strict()).min(1).max(100)
}).strict().superRefine((value, ctx) => {
  if (value.command.recipients.length !== value.recipients.length || value.command.recipients.some((recipient, index) => recipient.recipientId !== value.recipients[index].id)) ctx.addIssue({ code: "custom", message: "original_native_recipient_required" });
  const original = enabledDocumentSignaturePolicySchema.safeParse(value.providerPolicy.originalValue);
  if (!original.success || JSON.stringify(original.data) !== JSON.stringify(value.providerPolicy.value)) ctx.addIssue({ code: "custom", message: "original_native_signature_policy_required" });
});
export const signaturePreparationReceiptSchema = z.object({ recorded: z.literal(true), id: z.uuid(), signatureId: z.uuid(), idempotencyKey: z.uuid(), state: z.enum(["ADMITTED", "PREPARED", "UNCERTAIN", "SUPERSEDED", "SOURCE_CHANGED"]) }).strict();
export const signaturePreparationRecoverySchema = z.discriminatedUnion("recorded", [signaturePreparationReceiptSchema, z.object({ recorded: z.literal(false), id: z.null(), idempotencyKey: z.uuid(), state: z.null() }).strict()]);
export const signaturePreparationTargetInput = z.object({ signatureId: z.uuid() }).strict();
export const signaturePreparationTargetSchema = z.object({ signatureId: z.uuid(), document: z.object({ id: z.uuid(), instanceId: z.uuid(), versionId: z.uuid(), title: z.string(), locale: z.enum(["en", "fr", "ar"]), sha256: sha, pageCount: z.number().int().positive() }).strict(),
  recipients: z.array(z.object({ id: z.uuid(), displayName: z.string(), email: z.email() }).strict()).min(1).max(100),
  signing: z.object({ order: signatureSigningOrderSchema, methods: signatureMethodsSchema, delivery: signatureDeliveryOptionsSchema }).strict(), signatureLevel: z.string() }).strict();
export const signaturePreparationReviewSchema = signaturePreparationTargetSchema.extend({ reviewFingerprint: sha });
