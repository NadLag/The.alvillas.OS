import { z } from "zod";
import { signatureMaximumEvidenceBytes, signatureObservationFactsSchema, signatureRequestIdSchema, signatureTeamIdSchema } from "@/platform/providers/signature-contract";

export const signatureProviderEvidenceProtocol = "ALVILLAS_SIGNATURE_PROVIDER_EVIDENCE_V1";
export const signatureProviderEvidenceMaximumBytes = 4 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const signatureProviderEvidenceSourceSchema = z.object({ organizationId: z.uuid(), signatureId: z.uuid(), intentId: z.uuid(), attemptId: z.uuid(), evidenceId: z.uuid(), commandHash: sha, providerScopeHash: sha, contractHash: sha, originalPdfSha256: sha }).strict();
export const signatureProviderEvidenceIdentitySchema = signatureProviderEvidenceSourceSchema.extend({ sha256: sha, byteSize: z.number().int().positive().max(signatureProviderEvidenceMaximumBytes) });
const encodedEvidence = z.base64().min(4).max(Math.ceil(signatureMaximumEvidenceBytes / 3) * 4);
export const signatureProviderEvidencePayloadSchema = z.object({ protocol: z.literal(signatureProviderEvidenceProtocol), schemaVersion: z.literal(1), identity: signatureProviderEvidenceSourceSchema,
  kind: z.enum(["PREPARED", "SENT", "UNCERTAIN", "VIEWED", "DECLINED", "EXPIRED", "COMPLETION", "OBSERVED"]), providerRequestId: signatureRequestIdSchema.nullable(), observation: signatureObservationFactsSchema.nullable(),
  prepareReceipt: encodedEvidence.nullable(), observationReceipt: encodedEvidence.nullable(),
  distributionReceipt: encodedEvidence.nullable().optional(),
  distributionProof: z.enum(["POST_ACKNOWLEDGED", "READBACK_RECONCILED", "WEBHOOK_READBACK"]).nullable().optional(),
  webhook: z.object({ id: z.uuid(), providerEventId: sha, payloadSha256: sha, occurredAt: z.iso.datetime() }).strict().nullable().optional(),
  scopeProof: z.object({ requestId: signatureRequestIdSchema, reference: z.string().min(1).max(255), teamId: signatureTeamIdSchema, origin: z.url(), fingerprint: sha }).strict(),
  failureCode: z.enum(["SIGNATURE_OUTCOME_UNCONFIRMED", "SIGNATURE_CONTRACT_UNCONFIRMED"]).nullable()
}).strict().superRefine((value, ctx) => {
  if (value.observation && value.providerRequestId !== value.observation.requestId) ctx.addIssue({ code: "custom", message: "original_provider_request_required" });
  if (value.kind === "PREPARED" && (!value.observation || value.observation.status !== "DRAFT" || value.observation.distributionMethod !== "NONE" || !value.prepareReceipt || !value.observationReceipt || value.distributionReceipt || value.distributionProof || value.webhook || value.failureCode !== null)) ctx.addIssue({ code: "custom", message: "private_preparation_confirmation_required" });
  const distributionConfirmed = value.distributionProof === "POST_ACKNOWLEDGED" && Boolean(value.distributionReceipt) || value.distributionProof === "READBACK_RECONCILED" && !value.distributionReceipt || value.distributionProof === "WEBHOOK_READBACK" && Boolean(value.webhook) && !value.distributionReceipt;
  if (value.kind === "SENT" && (!value.observation || !["PENDING", "COMPLETED"].includes(value.observation.status) || value.observation.distributionMethod !== "EMAIL" || !value.observation.recipients.some(recipient => recipient.role === "SIGNER" && recipient.sendStatus === "SENT") || !value.prepareReceipt && !value.webhook || !value.observationReceipt || !distributionConfirmed || value.failureCode !== null)) ctx.addIssue({ code: "custom", message: "actual_distribution_confirmation_required" });
  if (["VIEWED", "DECLINED", "EXPIRED", "COMPLETION", "OBSERVED"].includes(value.kind) && (!value.webhook || !value.observation || !value.observationReceipt || value.failureCode !== null || value.distributionProof || value.distributionReceipt)) ctx.addIssue({ code: "custom", message: "authenticated_webhook_readback_required" });
  if (value.kind === "VIEWED" && !value.observation?.recipients.some(recipient => recipient.readStatus === "OPENED")) ctx.addIssue({ code: "custom", message: "actual_recipient_view_required" });
  if (value.kind === "DECLINED" && !value.observation?.recipients.some(recipient => recipient.signingStatus === "REJECTED" && ["SIGNER", "APPROVER"].includes(recipient.role))) ctx.addIssue({ code: "custom", message: "actual_recipient_rejection_required" });
  if (value.kind === "EXPIRED" && !value.observation?.recipients.some(recipient => recipient.expiresAt && value.webhook && Date.parse(recipient.expiresAt) <= Date.parse(value.webhook.occurredAt) && recipient.signingStatus === "NOT_SIGNED" && ["SIGNER", "APPROVER"].includes(recipient.role))) ctx.addIssue({ code: "custom", message: "actual_required_recipient_expiry_required" });
  const required = value.observation?.recipients.filter(recipient => ["SIGNER", "APPROVER"].includes(recipient.role)) ?? [];
  if (value.kind === "COMPLETION" && (value.observation?.status !== "COMPLETED" || !required.some(recipient => recipient.role === "SIGNER") || required.some(recipient => recipient.signingStatus !== "SIGNED" || !recipient.signedAt))) ctx.addIssue({ code: "custom", message: "all_required_provider_actions_completed_required" });
  if (value.kind === "UNCERTAIN" && (value.failureCode === null || value.distributionProof === "READBACK_RECONCILED")) ctx.addIssue({ code: "custom", message: "uncertain_provider_effect_required" });
  if (value.kind !== "SENT" && value.distributionProof === "WEBHOOK_READBACK") ctx.addIssue({ code: "custom", message: "verified_webhook_distribution_required" });
  if (["VIEWED", "DECLINED", "EXPIRED", "COMPLETION"].includes(value.kind) && value.observation?.distributionMethod !== "EMAIL") ctx.addIssue({ code: "custom", message: "actual_distributed_original_required" });
  if (value.kind === "DECLINED" && !["PENDING", "REJECTED"].includes(value.observation?.status ?? "")) ctx.addIssue({ code: "custom", message: "consistent_actual_rejection_required" });
  if (value.kind === "EXPIRED" && value.observation?.status !== "PENDING") ctx.addIssue({ code: "custom", message: "consistent_pending_expiry_required" });
});
