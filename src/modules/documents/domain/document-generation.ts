import { z } from "zod";
import { authorizationCapSchema } from "@/platform/authz/authorization-cap";
import { documentArchivePolicySchema } from "./document-policy";
import { documentSourceReferenceSchema, documentUploadReviewInput, documentUploadInput } from "./document-command";
import { documentTemplateMaximumBytes } from "./document-template-format";
import { documentTemplateVariableKeySchema } from "./document-template";

export const documentGenerationRequested = "documents.instance.requested";
export const documentGenerationProtocol = "ALVILLAS_GENERATED_DOCUMENT_V1";
export const documentGenerationMaximumInputBytes = documentTemplateMaximumBytes + 16384;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const documentGenerationDraftSchema = z.object({
  templateVersionId: z.uuid(), variantVersionIds: z.array(z.uuid()).min(2).max(3).refine(values => new Set(values).size === values.length),
  source: documentSourceReferenceSchema, title: documentUploadReviewInput.shape.title,
  effectiveFrom: documentUploadReviewInput.shape.effectiveFrom
}).strict().superRefine((value, ctx) => { if (!value.variantVersionIds.includes(value.templateVersionId)) ctx.addIssue({ code: "custom", message: "selected_original_variant_required" }); });
export const documentGenerationCommandSchema = documentGenerationDraftSchema.safeExtend({
  idempotencyKey: documentUploadInput.shape.idempotencyKey, reviewFingerprint: documentUploadInput.shape.reviewFingerprint,
  reason: documentUploadInput.shape.reason
});
export const documentGenerationIdentitySchema = z.object({
  organizationId: z.uuid(), documentId: z.uuid(), instanceId: z.uuid(), templateVersionId: z.uuid(), templateSha256: sha256,
  sourceFingerprint: sha256, sha256, byteSize: z.number().int().min(1).max(documentGenerationMaximumInputBytes)
}).strict();
export type DocumentGenerationIdentity = z.infer<typeof documentGenerationIdentitySchema>;
const variant = z.object({ versionId: z.uuid(), documentId: z.uuid(), fingerprint: sha256, sha256, locale: z.enum(["en", "fr", "ar"]) }).strict();
/** Private immutable instance snapshot. Public requests can supply only the draft/command above. */
export const documentGenerationSnapshotSchema = z.object({
  protocol: z.literal(documentGenerationProtocol), schemaVersion: z.literal(1), identity: documentGenerationIdentitySchema,
  command: documentGenerationCommandSchema, commandHash: sha256, nativeSourceFingerprint: sha256,
  policySnapshot: z.object({ id: z.uuid(), version: z.number().int().positive(), value: documentArchivePolicySchema }).strict(),
  authorizationCap: authorizationCapSchema, variants: z.array(variant).min(2).max(3), contractFingerprint: sha256,
  sourceKeys: z.array(documentTemplateVariableKeySchema).max(200).refine(values => new Set(values).size === values.length),
  payloadCipher: z.base64().max(Math.ceil((documentGenerationMaximumInputBytes + 256) / 3) * 4)
}).strict().superRefine((value, ctx) => {
  if (value.authorizationCap.organizationId !== value.identity.organizationId || value.command.templateVersionId !== value.identity.templateVersionId)
    ctx.addIssue({ code: "custom", message: "original_generation_identity_required" });
  if (new Set(value.variants.map(item => item.locale)).size !== value.variants.length || !value.variants.some(item => item.locale === "en") || !value.variants.some(item => item.locale === "fr") || !value.variants.some(item => item.versionId === value.identity.templateVersionId))
    ctx.addIssue({ code: "custom", message: "explicit_original_generation_variants_required" });
  if (!value.payloadCipher.length) ctx.addIssue({ code: "custom", message: "encrypted_original_render_input_required" });
  const cipherBytes = value.payloadCipher.length * 3 / 4 - (value.payloadCipher.endsWith("==") ? 2 : value.payloadCipher.endsWith("=") ? 1 : 0);
  if (cipherBytes <= value.identity.byteSize || cipherBytes > value.identity.byteSize + 256)
    ctx.addIssue({ code: "custom", message: "original_generation_cipher_size_required" });
  if (new Set(value.variants.map(item => item.versionId)).size !== value.variants.length ||
    value.variants.find(item => item.versionId === value.identity.templateVersionId)?.sha256 !== value.identity.templateSha256)
    ctx.addIssue({ code: "custom", message: "original_generation_template_hash_required" });
  if (JSON.stringify(value.variants.map(item => item.versionId).sort()) !== JSON.stringify([...value.command.variantVersionIds].sort()))
    ctx.addIssue({ code: "custom", message: "original_explicit_variant_selection_required" });
});
export type DocumentGenerationSnapshot = z.infer<typeof documentGenerationSnapshotSchema>;
export const documentGenerationReceiptSchema = z.object({ recorded: z.literal(true), id: z.uuid(), documentId: z.uuid(), idempotencyKey: z.uuid(),
  state: z.enum(["PENDING", "COMPLETE", "SOURCE_CHANGED"]), versionId: z.uuid().nullable() }).strict();
