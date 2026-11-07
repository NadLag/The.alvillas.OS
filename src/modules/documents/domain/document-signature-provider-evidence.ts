import { z } from "zod";
import { signatureMaximumEvidenceBytes, signatureObservationFactsSchema, signatureRequestIdSchema, signatureTeamIdSchema } from "@/platform/providers/signature-contract";

export const signatureProviderEvidenceProtocol = "ALVILLAS_SIGNATURE_PROVIDER_EVIDENCE_V1";
export const signatureProviderEvidenceMaximumBytes = 4 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signatureProviderEvidenceSourceSchema = z.object({ organizationId: z.uuid(), signatureId: z.uuid(), intentId: z.uuid(), attemptId: z.uuid(), evidenceId: z.uuid(), commandHash: sha, providerScopeHash: sha, contractHash: sha, originalPdfSha256: sha }).strict();
export const signatureProviderEvidenceIdentitySchema = signatureProviderEvidenceSourceSchema.extend({ sha256: sha, byteSize: z.number().int().positive().max(signatureProviderEvidenceMaximumBytes) });
const encodedEvidence = z.base64().min(4).max(Math.ceil(signatureMaximumEvidenceBytes / 3) * 4);
export const signatureProviderEvidencePayloadSchema = z.object({ protocol: z.literal(signatureProviderEvidenceProtocol), schemaVersion: z.literal(1), identity: signatureProviderEvidenceSourceSchema,
  kind: z.enum(["PREPARED", "SENT", "UNCERTAIN"]), providerRequestId: signatureRequestIdSchema.nullable(), observation: signatureObservationFactsSchema.nullable(),
  prepareReceipt: encodedEvidence.nullable(), observationReceipt: encodedEvidence.nullable(),
  distributionReceipt: encodedEvidence.nullable().optional(),
  distributionProof: z.enum(["POST_ACKNOWLEDGED", "READBACK_RECONCILED"]).nullable().optional(),
  scopeProof: z.object({ requestId: signatureRequestIdSchema, reference: z.string().min(1).max(255), teamId: signatureTeamIdSchema, origin: z.url(), fingerprint: sha }).strict(),
  failureCode: z.enum(["SIGNATURE_OUTCOME_UNCONFIRMED", "SIGNATURE_CONTRACT_UNCONFIRMED"]).nullable()
}).strict().superRefine((value, ctx) => {
  if (value.observation && value.providerRequestId !== value.observation.requestId) ctx.addIssue({ code: "custom", message: "original_provider_request_required" });
  if (value.kind === "PREPARED" && (!value.observation || value.observation.status !== "DRAFT" || value.observation.distributionMethod !== "NONE" || !value.prepareReceipt || !value.observationReceipt || value.distributionReceipt || value.distributionProof || value.failureCode !== null)) ctx.addIssue({ code: "custom", message: "private_preparation_confirmation_required" });
  const distributionConfirmed = value.distributionProof === "POST_ACKNOWLEDGED" && Boolean(value.distributionReceipt) || value.distributionProof === "READBACK_RECONCILED" && !value.distributionReceipt;
  if (value.kind === "SENT" && (!value.observation || !["PENDING", "COMPLETED"].includes(value.observation.status) || value.observation.distributionMethod !== "EMAIL" || !value.observation.recipients.some(recipient => recipient.role === "SIGNER" && recipient.sendStatus === "SENT") || !value.prepareReceipt || !value.observationReceipt || !distributionConfirmed || value.failureCode !== null)) ctx.addIssue({ code: "custom", message: "actual_distribution_confirmation_required" });
  if (value.kind === "UNCERTAIN" && (value.failureCode === null || value.distributionProof === "READBACK_RECONCILED")) ctx.addIssue({ code: "custom", message: "uncertain_provider_effect_required" });
});
