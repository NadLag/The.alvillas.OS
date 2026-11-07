import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { DocumentAccessError, DocumentConflictError, DocumentRateLimitError } from "../domain/document-command";
import { signatureWebhookReceived, signatureWebhookScopeSchema, signatureWebhookIdentitySchema } from "../domain/document-signature-webhook";
import { decodeDocumensoWebhook } from "../infrastructure/documenso-webhook";
import { sealSignatureWebhook } from "../infrastructure/document-signature-webhook-payload";
import { SignatureWebhookRepository } from "../infrastructure/signature-webhook-repository";
import { nativeSignatureOriginalDefinition } from "./document-signature-draft";
import { originalSignaturePreparation } from "./document-signature-preparation";
import { signatureProviderScopeHash } from "./document-signature-preparation-context";

type Scope = z.infer<typeof signatureWebhookScopeSchema>;
type Facts = ReturnType<typeof decodeDocumensoWebhook>;
type Dependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string };
export const signatureWebhookOutboxKey = (id: string) => "document-signature-webhook:" + id;
/** Route fields locate a candidate only; a real original attempt owns the account and request binding. */
async function originalBinding(tx: TenantTransaction, scope: Scope, facts: Facts) {
  const repository = new SignatureWebhookRepository(tx, scope.organizationId), account = await repository.scope(scope.providerScopeHash), known = await repository.preparedProviderBinding(scope.providerScopeHash, facts.requestId), reference = z.uuid().safeParse(facts.reference);
  if (!account || !known && !reference.success || known && facts.reference !== null && facts.reference !== known.signatureId) throw new DocumentAccessError();
  const signatureId = known?.signatureId ?? (reference.success ? reference.data : null), row = signatureId ? await repository.signatureRecord(signatureId) : null; if (!row) throw new DocumentAccessError();
  const original = nativeSignatureOriginalDefinition(row), attempt = await repository.preparationAttempt(row.id), intent = attempt ? await repository.preparation(attempt.intentId) : null; if (!attempt || !intent || intent.providerScopeHash !== scope.providerScopeHash || known && known.attemptId !== attempt.id) throw new DocumentAccessError();
  const prepared = originalSignaturePreparation(intent), selected = prepared.snapshot.providerPolicy.value.account;
  const originalIds = new Set(attempt.evidence.filter(row => row.webhookId === null && row.providerRequestId !== null).map(row => row.providerRequestId)); if (originalIds.size > 1 || originalIds.size === 1 && !originalIds.has(facts.requestId)) throw new DocumentConflictError();
  if (prepared.snapshot.signatureCommandHash !== row.commandHash || prepared.snapshot.document.versionId !== row.documentVersionId || selected.origin !== account.origin || selected.teamId !== account.teamId || signatureProviderScopeHash(selected.origin, selected.teamId) !== scope.providerScopeHash) throw new DocumentConflictError();
  return { repository, row, original, attempt, intent, prepared };
}
export async function receiveSignatureWebhook(rawScope: unknown, receivedSecret: string | null, bytes: Uint8Array, deps: Dependencies) {
  const env = deps.env ?? process.env, facts = decodeDocumensoWebhook(receivedSecret, env.DOCUMENSO_WEBHOOK_SECRET, bytes), scope = signatureWebhookScopeSchema.parse(rawScope);
  return withTenant(deps.db, scope.organizationId, async tx => {
    const binding = await originalBinding(tx, scope, facts), { repository } = binding; await repository.lock("signature-webhook:" + scope.providerScopeHash + ":" + facts.eventId);
    const existing = await repository.webhookByEvent(scope.providerScopeHash, facts.eventId); if (existing) { if (existing.signatureId !== binding.row.id || existing.preparationAttemptId !== binding.attempt.id || existing.providerRequestId !== facts.requestId) throw new DocumentConflictError(); return { received: true as const, id: existing.id }; }
    const now = await repository.clock(), budget = binding.original.snapshot.archivePolicy.value.upload_admission, rate = await consumeRateLimit(tx, scope.organizationId, { key: "document-signature-webhook:" + scope.providerScopeHash, limit: budget.max_requests, windowSeconds: budget.window_seconds, now }); if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt);
    const id = randomUUID(), identity = signatureWebhookIdentitySchema.parse({ ...scope, webhookId: id, signatureId: binding.row.id, preparationAttemptId: binding.attempt.id, providerRequestId: facts.requestId, providerEventId: facts.eventId, eventType: facts.event, occurredAt: facts.createdAt, payloadSha256: facts.evidenceSha256, payloadByteSize: facts.evidence.length }), cipher = sealSignatureWebhook(identity, facts.evidence, env);
    await repository.appendWebhook({ id, signatureId: binding.row.id, preparationAttemptId: binding.attempt.id, providerScopeHash: scope.providerScopeHash, providerRequestId: facts.requestId, providerEventId: facts.eventId, eventType: facts.event, payloadSha256: facts.evidenceSha256, payloadByteSize: facts.evidence.length, payloadCipher: cipher, occurredAt: new Date(facts.createdAt), receivedAt: now });
    await writeAuditEvent(tx, { organizationId: scope.organizationId, actorId: null, action: "documents.signature.webhook_received", resourceType: "signature", resourceId: id,
      after: { signatureId: binding.row.id, webhookId: id, preparationAttemptId: binding.attempt.id, providerScopeHash: scope.providerScopeHash, providerEventId: facts.eventId, payloadSha256: facts.evidenceSha256 }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await new OutboxRepository(tx, scope.organizationId).append(signatureWebhookReceived, { webhookId: id }, signatureWebhookOutboxKey(id), now);
    return { received: true as const, id };
  });
}
