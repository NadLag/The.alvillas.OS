import { z } from "zod";
import { documentArchivePolicySchema } from "./document-policy";
import { documentSourceReferenceSchema, documentUploadInput } from "./document-command";

export const nativeSignatureProtocol = "ALVILLAS_NATIVE_SIGNATURE_REQUEST_V1";
export const nativeSignatureRecipientProtocol = "ALVILLAS_NATIVE_SIGNATURE_RECIPIENT_V1";
export const nativeSignatureDraftCreated = "documents.signature.draft_created";
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signatureRecipientReferenceSchema = z.object({ kind: z.enum(["PERSON", "OWNER", "GUEST", "SUPPLIER", "LEAD"]), id: z.uuid() }).strict();
export const nativeLeadContractPolicySchema=z.object({id:z.uuid(),version:z.number().int().positive(),contractTypeKeys:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u)).min(1).max(100).refine(values=>new Set(values).size===values.length)}).strict();
export const nativeSignatureDraftSchema = z.object({ instanceId: z.uuid(), documentVersionId: z.uuid(), recipients: z.array(signatureRecipientReferenceSchema).min(1).max(100)
  .refine(values => new Set(values.map(value => value.kind + ":" + value.id)).size === values.length) }).strict();
export const nativeSignatureCommandSchema = nativeSignatureDraftSchema.extend({ idempotencyKey: documentUploadInput.shape.idempotencyKey,
  reviewFingerprint: documentUploadInput.shape.reviewFingerprint, reason: documentUploadInput.shape.reason });
export const nativeSignatureRecipientIdentitySchema = z.object({ organizationId: z.uuid(), signatureId: z.uuid(), recipientId: z.uuid(), reference: signatureRecipientReferenceSchema, fingerprint: sha }).strict();
export const nativeSignatureRecipientPayloadSchema = z.object({ protocol: z.literal(nativeSignatureRecipientProtocol), schemaVersion: z.literal(1), identity: nativeSignatureRecipientIdentitySchema,
  displayName: z.string().min(1).max(500), email: z.email().max(254) }).strict();
export const nativeSignatureSnapshotSchema = z.object({ protocol: z.literal(nativeSignatureProtocol), schemaVersion: z.literal(1), command: nativeSignatureCommandSchema, commandHash: sha,
  document: z.object({ id: z.uuid(), instanceId: z.uuid(), versionId: z.uuid(), admissionId: z.uuid(), sha256: sha, byteSize: z.number().int().positive(), locale: z.enum(["en", "fr", "ar"]), source: documentSourceReferenceSchema }).strict(),
  archiveFingerprint: sha, nativeSourceFingerprint: sha, archivePolicy: z.object({ id: z.uuid(), version: z.number().int().positive(), value: documentArchivePolicySchema }).strict(),leadContractPolicy:nativeLeadContractPolicySchema.optional(),
  recipients: z.array(z.object({ reference: signatureRecipientReferenceSchema, identityHash: sha, fingerprint: sha }).strict()).min(1).max(100)
}).strict().superRefine((value, ctx) => {
  if(value.document.source.kind==="LEAD"? !value.leadContractPolicy||!value.command.recipients.some(recipient=>recipient.kind==="LEAD"&&recipient.id.toLowerCase()===value.document.source.id.toLowerCase())||value.command.recipients.some(recipient=>recipient.kind==="LEAD"&&recipient.id.toLowerCase()!==value.document.source.id.toLowerCase()) : value.leadContractPolicy||value.command.recipients.some(recipient=>recipient.kind==="LEAD"))ctx.addIssue({code:"custom",message:"native_lead_contract_signer_required"});
  if (value.command.instanceId !== value.document.instanceId || value.command.documentVersionId !== value.document.versionId || value.recipients.length !== value.command.recipients.length ||
    value.recipients.some((recipient, index) => recipient.reference.kind !== value.command.recipients[index].kind || recipient.reference.id !== value.command.recipients[index].id)) ctx.addIssue({ code: "custom", message: "original_signature_intent_required" });
});
export const nativeSignatureReceiptSchema = z.object({ recorded: z.literal(true), id: z.uuid(), idempotencyKey: z.uuid(), documentId: z.uuid(), instanceId: z.uuid(), documentVersionId: z.uuid(), state: z.enum(["DRAFT", "SOURCE_CHANGED"]) }).strict();
const party = z.object({ reference: signatureRecipientReferenceSchema, displayName: z.string(), email: z.email(), fingerprint: sha, identityHash: sha }).strict();
export const nativeSignatureReviewSchema = z.object({ reviewFingerprint: sha, document: z.object({ id: z.uuid(), instanceId: z.uuid(), versionId: z.uuid(), title: z.string(), sha256: sha, locale: z.enum(["en", "fr", "ar"]) }).strict(), recipients: z.array(party).min(1).max(100), privacy: z.array(z.string()) }).strict();
export const nativeSignatureRecoverySchema = z.discriminatedUnion("recorded", [nativeSignatureReceiptSchema, z.object({ recorded: z.literal(false), id: z.null(), idempotencyKey: z.uuid(), state: z.null() }).strict()]);
export const nativeSignatureChoicesInput = z.object({ documentVersionId: z.uuid(), kind: signatureRecipientReferenceSchema.shape.kind, query: z.string().trim().max(120).default(""), cursor: z.string().max(6000).optional() }).strict();
export const nativeSignatureChoicesSchema = z.object({ instanceId: z.uuid(), documentVersionId: z.uuid(), items: z.array(party).max(30), next: z.string().nullable() }).strict();
