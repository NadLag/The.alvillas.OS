import { z } from "zod";
import { signatureMaximumEvidenceBytes, signatureRequestIdSchema } from "@/platform/providers/signature-contract";

export const signatureWebhookReceived = "documents.signature.webhook_received";
export const signatureWebhookScopeSchema = z.object({ organizationId: z.uuid(), providerScopeHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const signatureWebhookIdentitySchema = signatureWebhookScopeSchema.extend({ webhookId: z.uuid(), signatureId: z.uuid(), preparationAttemptId: z.uuid(), providerRequestId: signatureRequestIdSchema,
  providerEventId: z.string().regex(/^[a-f0-9]{64}$/u), eventType: z.string().min(1).max(60), occurredAt: z.iso.datetime(), payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u), payloadByteSize: z.number().int().positive().max(signatureMaximumEvidenceBytes) });
