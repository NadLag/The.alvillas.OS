import { z } from "zod";
import { signatureRequestIdSchema, signatureRecipientRoleSchema } from "@/platform/providers/signature-contract";
import { documentUploadInput } from "./document-command";
import { signaturePreparationSnapshotSchema, signaturePreparationTargetSchema } from "./document-signature-preparation";
import { enabledDocumentSignaturePolicySchema } from "./document-signature-policy";

export const signatureDistributionProtocol = "ALVILLAS_SIGNATURE_DISTRIBUTION_V1";
export const signatureDistributionRequested = "documents.signature.distribute_requested";
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signatureDistributionReviewInput = z.object({ preparationId: z.uuid() }).strict();
export const signatureDistributionCommandSchema = signatureDistributionReviewInput.extend({ delivery: z.literal("EMAIL"),
  idempotencyKey: documentUploadInput.shape.idempotencyKey, reviewFingerprint: documentUploadInput.shape.reviewFingerprint, reason: documentUploadInput.shape.reason });
export const signatureDistributionSnapshotSchema = z.object({ protocol: z.literal(signatureDistributionProtocol), schemaVersion: z.literal(1),
  command: signatureDistributionCommandSchema, commandHash: sha, signatureId: z.uuid(), signatureCommandHash: sha, contextFingerprint: sha, contractHash: sha,
  document: signaturePreparationSnapshotSchema.shape.document, providerPolicy: signaturePreparationSnapshotSchema.shape.providerPolicy, providerScopeHash: sha,
  recipients: signaturePreparationSnapshotSchema.shape.recipients,
  preparation: z.object({ intentId: z.uuid(), attemptId: z.uuid(), evidenceId: z.uuid(), commandHash: sha, providerRequestId: signatureRequestIdSchema }).strict()
}).strict().superRefine((value, ctx) => {
  if (value.command.preparationId !== value.preparation.intentId) ctx.addIssue({ code: "custom", message: "original_native_preparation_required" });
  const policy = enabledDocumentSignaturePolicySchema.safeParse(value.providerPolicy.originalValue);
  if (!policy.success || JSON.stringify(policy.data) !== JSON.stringify(value.providerPolicy.value)) ctx.addIssue({ code: "custom", message: "original_native_signature_policy_required" });
});
export const signatureDistributionReviewSchema = signaturePreparationTargetSchema.extend({ preparationId: z.uuid(), reviewFingerprint: sha, recipientRoles: z.array(z.object({ recipientId: z.uuid(), role: signatureRecipientRoleSchema, signingOrder: z.number().int().nonnegative(), fieldCount: z.number().int().nonnegative() }).strict()).min(1).max(100) });
export const signatureDistributionReceiptSchema = z.object({ recorded: z.literal(true), id: z.uuid(), signatureId: z.uuid(), preparationId: z.uuid(), idempotencyKey: z.uuid(), state: z.enum(["ADMITTED", "SENT", "UNCERTAIN", "SUPERSEDED", "SOURCE_CHANGED"]) }).strict();
export const signatureDistributionRecoverySchema = z.discriminatedUnion("recorded", [signatureDistributionReceiptSchema, z.object({ recorded: z.literal(false), id: z.null(), idempotencyKey: z.uuid(), state: z.null() }).strict()]);
export const signatureDistributionReconcileInput = z.object({ distributionId: z.uuid() }).strict();
export const signatureDistributionReconciliationSchema = signatureDistributionReceiptSchema.omit({ recorded: true, idempotencyKey: true });
