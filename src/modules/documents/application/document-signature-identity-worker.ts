import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { signatureObservationFactsSchema } from "@/platform/providers/signature-contract";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { signatureIdentityRecoveryRequested } from "../domain/document-signature-identity-recovery";
import { SignatureIdentityRecoveryRepository } from "../infrastructure/signature-identity-recovery-repository";
import { documentActorContext } from "./document-archive";
import { originalSignatureIdentityRecovery, signatureIdentityRecoveryOutboxKey } from "./document-signature-identity-recovery";
import { nativeSignatureIdentityRecoveryContext, readSignatureIdentityCandidate, type SignatureIdentityRecoveryDependencies } from "./document-signature-identity-context";
import { appendNativeSignatureProviderEvidence } from "./document-signature-provider-evidence";
import { signatureWebhookOutboxKey } from "./document-signature-webhook";
import { executeSignatureWebhookReference } from "./document-signature-webhook-worker";

const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ recoveryId: z.uuid() }).strict();
type Reference = z.infer<typeof referenceSchema>;
type Dependencies = Omit<SignatureIdentityRecoveryDependencies, "db"> & { db?: SignatureIdentityRecoveryDependencies["db"] };
async function referenced(tx: TenantTransaction, reference: Reference) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload), repository = new SignatureIdentityRecoveryRepository(tx, reference.organizationId), row = payload.success ? await repository.identityRecovery(payload.data.recoveryId) : null;
  if (!event || event.type !== signatureIdentityRecoveryRequested || !row || event.idempotencyKey !== signatureIdentityRecoveryOutboxKey(row.requestedBy, row.commandKey) || event.occurredAt.getTime() !== row.requestedAt.getTime()) throw new DocumentAccessError();
  const original = originalSignatureIdentityRecovery(row), actor = documentActorContext({ organizationId: row.organizationId, actorId: row.requestedBy, authContext: original.cap }), attempt = await repository.preparationAttempt(row.signatureId); if (!attempt || attempt.id !== row.preparationAttemptId || attempt.intentId !== original.snapshot.original.intentId) throw new DocumentConflictError();
  const known = attempt.evidence.filter(item => item.webhookId === null && item.providerRequestId !== null); if (new Set(known.map(item => item.providerRequestId)).size > 1) throw new DocumentConflictError();
  return { event, repository, row, original, actor, attempt, known };
}
async function authorized(tx: TenantTransaction, initial: Awaited<ReturnType<typeof referenced>>, deps: SignatureIdentityRecoveryDependencies) {
  const current = await nativeSignatureIdentityRecoveryContext(initial.actor, tx, initial.original.snapshot.command, deps), snapshot = initial.original.snapshot;
  if (current.fingerprint !== snapshot.contextFingerprint || current.original.original.snapshot.contractHash !== snapshot.contractHash || current.current.row.commandHash !== snapshot.signatureCommandHash || current.attempt.id !== snapshot.original.attemptId || current.webhook.id !== snapshot.original.webhookId || current.webhook.providerRequestId !== snapshot.original.providerRequestId || current.webhook.providerScopeHash !== snapshot.providerScopeHash) throw new DocumentConflictError(); return current;
}
export async function executeSignatureIdentityRecoveryReference(raw: unknown, deps: Dependencies = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, options = { ...deps, db }, initial = await withTenant(db, reference.organizationId, tx => referenced(tx, reference));
  if (initial.known.some(item => item.providerRequestId !== initial.row.providerRequestId)) return { recoveryId: initial.row.id, state: "SUPERSEDED" as const };
  if (!initial.known.length) {
    const current = await withTenant(db, reference.organizationId, tx => authorized(tx, initial, options)), readback = await readSignatureIdentityCandidate(current, options); if (readback.identityHash !== initial.original.snapshot.reviewedIdentityHash || readback.providerCreatedAt !== initial.original.snapshot.original.providerCreatedAt) throw new DocumentConflictError();
    await withTenant(db, reference.organizationId, async tx => { const source = await referenced(tx, reference); await source.repository.lock("signature-provider:" + source.row.signatureId); const fresh = await referenced(tx, reference); if (fresh.known.length) return;
      const checked = await authorized(tx, fresh, options); if (checked.fingerprint !== current.fingerprint) throw new DocumentConflictError(); const draft = readback.observation.status === "DRAFT" && readback.observation.distributionMethod === "NONE";
      await appendNativeSignatureProviderEvidence(tx, fresh.repository, checked.original.intent, checked.attempt, checked.original.original.snapshot, { kind: draft ? "PREPARED" : "UNCERTAIN", providerRequestId: fresh.row.providerRequestId, prepareReceipt: null, preparationProof: "READBACK_IDENTITY_RECOVERY", identityRecovery: { id: fresh.row.id, commandHash: fresh.row.commandHash, requestedBy: fresh.row.requestedBy, reviewedIdentityHash: fresh.original.snapshot.reviewedIdentityHash }, observation: signatureObservationFactsSchema.strip().parse(readback.observation), observationReceipt: Buffer.from(readback.observation.evidence).toString("base64"), scopeProof: readback.scopeProof, failureCode: draft ? null : "SIGNATURE_PRIVATE_PREPARATION_ADVANCED" }, options);
      if ((await authorized(tx, fresh, options)).fingerprint !== checked.fingerprint) throw new DocumentConflictError(); });
  }
  const bound = await withTenant(db, reference.organizationId, tx => referenced(tx, reference)); if (bound.known.some(item => item.providerRequestId !== bound.row.providerRequestId)) return { recoveryId: bound.row.id, state: "SUPERSEDED" as const }; if (!bound.known.length) throw new DocumentConflictError();
  // Once the authorized binding commits, retained system facts do not borrow
  // that human's continuing grants. A lost worker acknowledgement repeats GETs.
  const webhook = await withTenant(db, reference.organizationId, tx => new OutboxRepository(tx, reference.organizationId).byIdempotencyKey(signatureWebhookOutboxKey(bound.row.webhookId))); if (!webhook) throw new DocumentConflictError();
  await executeSignatureWebhookReference({ organizationId: reference.organizationId, outboxEventId: webhook.id }, options);
  return { recoveryId: bound.row.id, state: bound.known.some(item => item.kind === "PREPARED") ? "BOUND_DRAFT" as const : "BOUND_ADVANCED" as const };
}
