import type { z } from "zod";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";
import type { SignatureProvider } from "@/platform/providers";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import type { signatureIdentityRecoveryDraftSchema } from "../domain/document-signature-identity-recovery";
import { SignatureIdentityRecoveryRepository } from "../infrastructure/signature-identity-recovery-repository";
import { signatureWebhookIdentitySchema } from "../domain/document-signature-webhook";
import { openSignatureWebhook } from "../infrastructure/document-signature-webhook-payload";
import { parseDocumensoWebhookEvidence } from "../infrastructure/documenso-webhook";
import { readOriginalSignatureProviderRequest } from "../infrastructure/signature-provider-boundary";
import { retainedNativeSignatureReadContext } from "./document-signature-history";
import { retainedSignatureProviderContract } from "./document-signature-retained-contract";
import type { DocumentActorContext } from "./document-archive";

export type SignatureIdentityRecoveryDependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string; provider?: Pick<SignatureProvider, "readSignatureRequest" | "downloadSignatureRequest">; providerOrigin?: string };
type Draft = z.infer<typeof signatureIdentityRecoveryDraftSchema>;
export async function signatureIdentityRecoveryAuthority(ctx: DocumentActorContext, tx: TenantTransaction, signatureId: string, deps: SignatureIdentityRecoveryDependencies) {
  const current = await retainedNativeSignatureReadContext(ctx, tx, signatureId, deps);
  const checks = current.current.archive.privacy.map(dataClass => ({ action: "edit" as const, resource: { ...current.current.archive.native.resource, type: "signature", id: current.row.id, documentId: current.current.instance.documentId, assignedUserAccountId: current.row.requestedBy, dataClass } })); await recheckAccountAuthorization(ctx, tx, current.current.archive.now, checks, new DocumentAccessError());
  return current;
}
export async function nativeSignatureIdentityRecoveryContext(ctx: DocumentActorContext, tx: TenantTransaction, draft: Draft, deps: SignatureIdentityRecoveryDependencies) {
  const repository = new SignatureIdentityRecoveryRepository(tx, ctx.organizationId), current = await signatureIdentityRecoveryAuthority(ctx, tx, draft.signatureId, deps), attempt = await repository.preparationAttempt(draft.signatureId), webhook = await repository.webhook(draft.webhookId); if (!attempt || !webhook || webhook.signatureId !== draft.signatureId || webhook.preparationAttemptId !== attempt.id) throw new DocumentAccessError();
  const original = await retainedSignatureProviderContract(tx, ctx.organizationId, attempt.intentId, deps.env); if (original.intent.providerScopeHash !== webhook.providerScopeHash || original.signature.id !== current.row.id) throw new DocumentConflictError();
  const identity = signatureWebhookIdentitySchema.parse({ organizationId: ctx.organizationId, webhookId: webhook.id, signatureId: webhook.signatureId, preparationAttemptId: webhook.preparationAttemptId, providerScopeHash: webhook.providerScopeHash, providerRequestId: webhook.providerRequestId, providerEventId: webhook.providerEventId, eventType: webhook.eventType, occurredAt: webhook.occurredAt.toISOString(), payloadSha256: webhook.payloadSha256, payloadByteSize: webhook.payloadByteSize }), facts = parseDocumensoWebhookEvidence(openSignatureWebhook(identity, webhook.payloadCipher, deps.env));
  if (facts.eventId !== webhook.providerEventId || facts.requestId !== webhook.providerRequestId || facts.reference !== current.row.id || facts.evidenceSha256 !== webhook.payloadSha256) throw new DocumentConflictError();
  const knownIds = new Set(attempt.evidence.filter(row => row.webhookId === null && row.providerRequestId !== null).map(row => row.providerRequestId)); if (knownIds.size > 1) throw new DocumentConflictError();
  const fingerprint = commandFingerprint({ current: current.fingerprint, signatureId: current.row.id, signatureCommandHash: current.row.commandHash, attemptId: attempt.id, intentId: original.intent.id, commandHash: original.intent.commandHash, webhookId: webhook.id, payloadSha256: webhook.payloadSha256, providerRequestId: webhook.providerRequestId, providerScopeHash: webhook.providerScopeHash, contractHash: original.original.snapshot.contractHash });
  return { repository, current, attempt, webhook, original, knownIds, fingerprint };
}
export async function readSignatureIdentityCandidate(current: Awaited<ReturnType<typeof nativeSignatureIdentityRecoveryContext>>, deps: SignatureIdentityRecoveryDependencies) { return readOriginalSignatureProviderRequest(current.original.policy.account, current.original.metadata, current.webhook.providerRequestId, deps); }
export function signatureIdentityReviewFingerprint(ctx: DocumentActorContext, current: Awaited<ReturnType<typeof nativeSignatureIdentityRecoveryContext>>, identityHash: string) { return commandFingerprint({ actorId: ctx.actorId, scope: current.fingerprint, identityHash, cap: captureAuthorizationCap(ctx.authContext) }); }
