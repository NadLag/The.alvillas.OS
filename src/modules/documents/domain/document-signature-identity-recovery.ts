import { z } from "zod";
import { documentUploadInput } from "./document-command";
import { signaturePreparationSnapshotSchema } from "./document-signature-preparation";
import { signatureProviderStatusSchema } from "@/platform/providers/signature-contract";

export const signatureIdentityRecoveryProtocol = "ALVILLAS_SIGNATURE_IDENTITY_RECOVERY_V1";
export const signatureIdentityRecoveryRequested = "documents.signature.identity_recovery_requested";
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signatureIdentityRecoveryDraftSchema = z.object({ signatureId: z.uuid(), webhookId: z.uuid() }).strict();
export const signatureIdentityCandidatesInput = z.object({ signatureId: z.uuid(), cursor: z.string().max(6000).optional() }).strict();
export const signatureIdentityCandidatesSchema = z.object({ signatureId: z.uuid(), items: z.array(z.object({ webhookId: z.uuid(), occurredAt: z.iso.datetime(), receivedAt: z.iso.datetime() }).strict()).max(30), next: z.string().nullable() }).strict();
export const signatureIdentityRecoveryCommandSchema = signatureIdentityRecoveryDraftSchema.extend({ idempotencyKey: documentUploadInput.shape.idempotencyKey, reviewFingerprint: sha, reason: documentUploadInput.shape.reason });
export const signatureIdentityRecoveryReviewSchema = signatureIdentityRecoveryDraftSchema.extend({ reviewFingerprint: sha, document: z.object({ id: z.uuid(), versionId: z.uuid(), title: z.string(), sha256: sha, locale: z.enum(["en", "fr", "ar"]) }).strict(),
  candidate: z.object({ providerRequestId: z.string().min(1).max(255), status: signatureProviderStatusSchema, createdAt: z.iso.datetime().nullable(), observedAt: z.iso.datetime() }).strict(), recipients: z.array(z.object({ id: z.uuid(), displayName: z.string(), email: z.email() }).strict()).min(1).max(100) }).strict();
export const signatureIdentityRecoverySnapshotSchema = z.object({ protocol: z.literal(signatureIdentityRecoveryProtocol), schemaVersion: z.literal(1), command: signatureIdentityRecoveryCommandSchema, commandHash: sha, signatureId: z.uuid(), signatureCommandHash: sha,
  contextFingerprint: sha, contractHash: sha, providerScopeHash: sha, reviewedIdentityHash: sha,
  original: z.object({ intentId: z.uuid(), attemptId: z.uuid(), webhookId: z.uuid(), providerRequestId: z.string().min(1).max(255), providerCreatedAt: z.iso.datetime().nullable() }).strict(),
  document: signaturePreparationSnapshotSchema.shape.document, providerPolicy: signaturePreparationSnapshotSchema.shape.providerPolicy
}).strict().superRefine((value, ctx) => { if (value.command.signatureId !== value.signatureId || value.command.webhookId !== value.original.webhookId) ctx.addIssue({ code: "custom", message: "exact_original_identity_recovery_required" }); });
export const signatureIdentityRecoveryReceiptSchema = z.object({ recorded: z.literal(true), id: z.uuid(), signatureId: z.uuid(), idempotencyKey: z.uuid(), state: z.enum(["ADMITTED", "BOUND_DRAFT", "BOUND_ADVANCED", "UNCERTAIN", "SUPERSEDED", "SOURCE_CHANGED"]) }).strict();
export const signatureIdentityRecoveryRecoverySchema = z.discriminatedUnion("recorded", [signatureIdentityRecoveryReceiptSchema, z.object({ recorded: z.literal(false), id: z.null(), signatureId: z.null(), idempotencyKey: z.uuid(), state: z.null() }).strict()]);
