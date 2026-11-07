import { z } from "zod";
import { nativeSignatureSnapshotSchema } from "./document-signature-command";
import { signaturePreparationSnapshotSchema } from "./document-signature-preparation";
import { documentObjectIdentitySchema } from "./document-object";
import { documentPrivacyTags } from "./document-policy";
import { documentUploadInput } from "./document-command";

export const signedArchiveProtocol = "ALVILLAS_SIGNED_SIGNATURE_ARCHIVE_V1";
export const signedArchiveRequested = "documents.signature.signed_archive_requested";
export const signedArchiveAssetKinds = ["SIGNED_ORIGINAL", "CERTIFICATE"] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signedArchiveSnapshotSchema = z.object({ protocol: z.literal(signedArchiveProtocol), schemaVersion: z.literal(1), signatureId: z.uuid(), signatureCommandHash: sha, contractHash: sha,
  preparation: z.object({ intentId: z.uuid(), attemptId: z.uuid(), commandHash: sha }).strict(), completion: z.object({ evidenceId: z.uuid(), payloadSha256: sha }).strict(), providerScopeHash: sha, providerRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/u),
  document: nativeSignatureSnapshotSchema.shape.document, title: z.string().min(1).max(500), typeKey: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u), privacy: z.array(z.enum(documentPrivacyTags)).max(3).refine(value => new Set(value).size === value.length),
  archivePolicy: nativeSignatureSnapshotSchema.shape.archivePolicy, providerPolicy: signaturePreparationSnapshotSchema.shape.providerPolicy,
  initiatedBy: z.uuid(), originalAuthorizationCap: z.json(), originalSourceFingerprint: sha
}).strict();
export const signedArchiveArtifactSnapshotSchema = z.object({ protocol: z.literal(signedArchiveProtocol), schemaVersion: z.literal(1), archiveId: z.uuid(), signatureId: z.uuid(), assetId: z.uuid(), kind: z.enum(signedArchiveAssetKinds), identity: documentObjectIdentitySchema, completionEvidenceId: z.uuid(), providerRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/u), contractHash: sha, sourceFingerprint: sha, sourceCanonical: z.string(), commandHash: sha, canonicalRequest: z.string() }).strict();
export const signedArchiveReceiptSchema = z.object({ signatureId: z.uuid(), archiveId: z.uuid().nullable(), state: z.enum(["AWAITING_COMPLETION", "PENDING", "COMPLETE"]), signedDocumentId: z.uuid().nullable(), certificateDocumentId: z.uuid().nullable(), signedVersionId: z.uuid().nullable(), certificateVersionId: z.uuid().nullable() }).strict().superRefine((value, ctx) => { if (value.state === "COMPLETE" ? !value.signedVersionId || !value.certificateVersionId || !value.signedDocumentId || !value.certificateDocumentId || !value.archiveId || value.signedVersionId === value.certificateVersionId || value.signedDocumentId === value.certificateDocumentId : Boolean(value.signedVersionId || value.certificateVersionId || value.signedDocumentId || value.certificateDocumentId)) ctx.addIssue({ code: "custom", message: "both_distinct_original_artifacts_required" }); });
export const signedArchiveStatusInput = z.object({ signatureId: z.uuid() }).strict();
export const signedArchiveCommandSchema = signedArchiveStatusInput.extend({ idempotencyKey: documentUploadInput.shape.idempotencyKey, reviewFingerprint: documentUploadInput.shape.reviewFingerprint, reason: documentUploadInput.shape.reason });
export const signedArchiveReviewSchema = z.object({ signatureId: z.uuid(), reviewFingerprint: sha, title: z.string(), originalVersionId: z.uuid(), canReconcile: z.boolean(), receipt: signedArchiveReceiptSchema }).strict();
export const signedArchiveReconciliationSchema = z.object({ protocol: z.literal(signedArchiveProtocol), input: signedArchiveCommandSchema, authorizationCap: z.json(), canonicalRequest: z.string(), archiveId: z.uuid() }).strict();
export const signedArchiveReconciliationReceiptSchema = z.object({ recorded: z.boolean(), id: z.uuid().nullable(), idempotencyKey: z.uuid(), receipt: signedArchiveReceiptSchema.nullable() }).strict();
