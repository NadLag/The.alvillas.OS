import { randomUUID } from "node:crypto";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { DocumentAccessError, DocumentConflictError, DocumentRateLimitError, documentRecoveryInput } from "../domain/document-command";
import { signatureDistributionCommandSchema, signatureDistributionReviewInput, signatureDistributionReviewSchema, signatureDistributionSnapshotSchema, signatureDistributionReceiptSchema, signatureDistributionRequested, signatureDistributionProtocol } from "../domain/document-signature-distribution";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { documentActorContext, documentJson, type DocumentActorContext } from "./document-archive";
import { nativeSignatureDistributionContext, signatureDistributionReviewFingerprint } from "./document-signature-distribution-context";
import { readSignaturePreparationTarget, type SignaturePreparationDependencies } from "./document-signature-preparation";

export type SignatureDistributionDependencies = SignaturePreparationDependencies;
type Intent = NonNullable<Awaited<ReturnType<SignaturePreparationRepository["distribution"]>>>;
export const signatureDistributionOutboxKey = (actorId: string, nonce: string) => "document-signature-send:" + actorId + ":" + nonce;
export function originalSignatureDistribution(row: Intent) {
  const snapshot = signatureDistributionSnapshotSchema.parse(row.policySnapshot), input = signatureDistributionCommandSchema.parse(row.input), original = { organizationId: row.organizationId, actorId: row.requestedBy, input: snapshot.command }, cap = restoreAuthorizationCap(row.authorizationCap);
  if (row.phase !== "SEND" || cap.organizationId !== row.organizationId || cap.userAccountId !== row.requestedBy || JSON.stringify(original) !== row.canonicalRequest || commandFingerprint(original) !== row.commandHash ||
    commandFingerprint(input) !== commandFingerprint(snapshot.command) || snapshot.commandHash !== row.commandHash || snapshot.command.idempotencyKey !== row.commandKey || snapshot.command.reason !== row.reason || snapshot.signatureId !== row.signatureId || snapshot.providerScopeHash !== row.providerScopeHash) throw new DocumentConflictError();
  return { snapshot, cap };
}
export async function signatureDistributionResult(ctx: DocumentActorContext, tx: TenantTransaction, row: Intent, env?: NodeJS.ProcessEnv) {
  if (row.requestedBy !== ctx.actorId) throw new DocumentAccessError(); const { snapshot, cap } = originalSignatureDistribution(row), original = documentActorContext({ ...ctx, authContext: cap }),
    current = await nativeSignatureDistributionContext(ctx, tx, snapshot.command.preparationId, env), held = await nativeSignatureDistributionContext(original, tx, snapshot.command.preparationId, env);
  if (current.fingerprint !== held.fingerprint) throw new DocumentConflictError(); const attempt = await current.repository.distributionAttempt(row.signatureId), confirmed = await current.repository.signatureSent(row.signatureId, row.providerScopeHash, snapshot.preparation.providerRequestId),
    state = attempt && attempt.intentId !== row.id ? "SUPERSEDED" : confirmed || attempt?.evidence.some(item => item.kind === "SENT") ? "SENT" : attempt ? "UNCERTAIN" : current.fingerprint !== snapshot.contextFingerprint ? "SOURCE_CHANGED" : "ADMITTED";
  return signatureDistributionReceiptSchema.parse({ recorded: true, id: row.id, signatureId: row.signatureId, preparationId: snapshot.preparation.intentId, idempotencyKey: row.commandKey, state });
}
export async function reviewSignatureDistribution(actor: DocumentActorContext, raw: unknown, deps: SignatureDistributionDependencies) {
  const ctx = documentActorContext(actor), input = signatureDistributionReviewInput.parse(raw), initial = await withTenant(deps.db, ctx.organizationId, tx => nativeSignatureDistributionContext(ctx, tx, input.preparationId, deps.env)),
    target = await readSignaturePreparationTarget(ctx, { signatureId: initial.row.id }, deps);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await nativeSignatureDistributionContext(ctx, tx, input.preparationId, deps.env); if (current.fingerprint !== initial.fingerprint) throw new DocumentConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.distribution_reviewed", resourceType: "signature", resourceId: current.row.id,
      after: { signatureId: current.row.id, preparationId: current.preparation.id, versionId: current.current.version.id, recipientCount: current.recipients.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.current.archive.now });
    const final = await nativeSignatureDistributionContext(ctx, tx, input.preparationId, deps.env); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return signatureDistributionReviewSchema.parse({ ...target, preparationId: final.preparation.id, reviewFingerprint: signatureDistributionReviewFingerprint(ctx, final),
      recipientRoles: final.recipients.map(recipient => ({ recipientId: recipient.id, role: recipient.layout.role, signingOrder: recipient.layout.signingOrder, fieldCount: recipient.layout.fields.length })) });
  });
}
async function otherNonce(repository: SignaturePreparationRepository, actorId: string, nonce: string) {
  if (await repository.providerPreparationByNonce(actorId, nonce) || await repository.byNonce(actorId, nonce) || await repository.instanceByNonce(actorId, nonce) || await repository.signatureByNonce(actorId, nonce)) throw new DocumentConflictError();
}
export async function admitSignatureDistribution(actor: DocumentActorContext, raw: unknown, deps: SignatureDistributionDependencies) {
  const ctx = documentActorContext(actor), command = signatureDistributionCommandSchema.parse(raw), original = { organizationId: ctx.organizationId, actorId: ctx.actorId, input: command }, canonicalRequest = JSON.stringify(original), commandHash = commandFingerprint(original);
  const replay = await withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignaturePreparationRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.distributionByNonce(ctx.actorId, command.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return signatureDistributionResult(ctx, tx, existing, deps.env); } await otherNonce(repository, ctx.actorId, command.idempotencyKey); return null; });
  if (replay) return replay;
  const rate = await withTenant(deps.db, ctx.organizationId, async tx => { const current = await nativeSignatureDistributionContext(ctx, tx, command.preparationId, deps.env); if (signatureDistributionReviewFingerprint(ctx, current) !== command.reviewFingerprint) throw new DocumentConflictError();
    const budget = current.current.archive.policy.value.upload_admission; return consumeRateLimit(tx, ctx.organizationId, { key: "document-signature-send:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.current.archive.now }); });
  if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new SignaturePreparationRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.distributionByNonce(ctx.actorId, command.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return signatureDistributionResult(ctx, tx, existing, deps.env); } await otherNonce(repository, ctx.actorId, command.idempotencyKey);
    const current = await nativeSignatureDistributionContext(ctx, tx, command.preparationId, deps.env); if (signatureDistributionReviewFingerprint(ctx, current) !== command.reviewFingerprint) throw new DocumentConflictError();
    const id = randomUUID(), now = current.current.archive.now, snapshot = signatureDistributionSnapshotSchema.parse({ protocol: signatureDistributionProtocol, schemaVersion: 1, command, commandHash, signatureId: current.row.id, signatureCommandHash: current.row.commandHash,
      contextFingerprint: current.fingerprint, contractHash: current.contractHash, document: current.original.snapshot.document, providerPolicy: current.policy, providerScopeHash: current.providerScopeHash,
      recipients: current.recipients.map(({ id, identityHash, fingerprint }) => ({ id, identityHash, fingerprint })), preparation: current.retainedPreparation });
    await repository.appendPreparation({ id, signatureId: current.row.id, phase: "SEND", commandKey: command.idempotencyKey, commandHash, canonicalRequest, input: documentJson(command), policySnapshot: documentJson(snapshot),
      authorizationCap: documentJson(captureAuthorizationCap(ctx.authContext)), sourceFingerprint: current.current.archive.native.fingerprint, providerScopeHash: current.providerScopeHash, reason: command.reason, requestedBy: ctx.actorId, requestedAt: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.distribution_requested", resourceType: "signature", resourceId: id,
      after: { signatureId: current.row.id, intentId: id, preparationId: current.preparation.id, commandHash, contractHash: current.contractHash }, reason: "Private distribution reason retained with its original native intent", requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await new OutboxRepository(tx, ctx.organizationId).append(signatureDistributionRequested, { intentId: id }, signatureDistributionOutboxKey(ctx.actorId, command.idempotencyKey), now);
    const final = await nativeSignatureDistributionContext(ctx, tx, command.preparationId, deps.env); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError(); const row = await repository.distribution(id); if (!row) throw new DocumentConflictError(); return signatureDistributionResult(ctx, tx, row, deps.env);
  });
}
export async function recoverSignatureDistribution(actor: DocumentActorContext, raw: unknown, deps: SignatureDistributionDependencies) {
  const ctx = documentActorContext(actor), input = documentRecoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignaturePreparationRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey);
    const row = await repository.distributionByNonce(ctx.actorId, input.idempotencyKey); if (row) return signatureDistributionResult(ctx, tx, row, deps.env);
    if (await repository.preparationNonceOwner(input.idempotencyKey) || await repository.signatureNonceOwner(input.idempotencyKey) || await repository.nonceOwner(input.idempotencyKey) || await repository.instanceNonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId); if ([current, ctx.authContext].some(cap => ["signature:view", "signature:edit", "document:view"].some(key => !cap.permissions.has(key)))) throw new DocumentAccessError();
    return { recorded: false as const, id: null, idempotencyKey: input.idempotencyKey, state: null };
  });
}
