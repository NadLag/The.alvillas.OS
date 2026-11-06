import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError, DocumentRateLimitError, documentRecoveryInput } from "../domain/document-command";
import { signaturePreparationCommandSchema, signaturePreparationDraftSchema, signaturePreparationSnapshotSchema, signaturePreparationReceiptSchema, signaturePreparationTargetInput, signaturePreparationTargetSchema, signaturePreparationReviewSchema, signaturePreparationProtocol, signaturePreparationRequested } from "../domain/document-signature-preparation";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { documentPdfPageCount } from "../infrastructure/document-pdf-metadata";
import type { DocumentObjectStore } from "../infrastructure/document-object-store";
import { documentActorContext, documentJson, downloadDocumentVersion, type DocumentActorContext } from "./document-archive";
import { configuredDocumentObjects } from "./document-files";
import { nativeSignaturePreparationContext, normalizedPreparationDraft, signaturePreparationReviewFingerprint, signaturePreparationTargetContext } from "./document-signature-preparation-context";

export type SignaturePreparationDependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; objects?: DocumentObjectStore; requestId?: string };
type Draft = z.infer<typeof signaturePreparationDraftSchema>;
type Intent = NonNullable<Awaited<ReturnType<SignaturePreparationRepository["preparation"]>>>;
const outboxKey = (actorId: string, nonce: string) => "document-signature-prepare:" + actorId + ":" + nonce;
export { outboxKey as signaturePreparationOutboxKey };
function targetView(current: Awaited<ReturnType<typeof signaturePreparationTargetContext>>, pageCount: number) {
  return signaturePreparationTargetSchema.parse({ signatureId: current.row.id, document: { id: current.current.instance.documentId, instanceId: current.current.instance.id, versionId: current.current.version.id, title: current.current.version.title, locale: current.current.instance.document.locale, sha256: current.current.version.admission.sha256, pageCount },
    recipients: current.recipients.map(({ id, displayName, email }) => ({ id, displayName, email })), signing: current.policy.value.signing, signatureLevel: current.policy.value.legal.signatureLevel });
}
async function actualPages(ctx: DocumentActorContext, versionId: string, deps: SignaturePreparationDependencies) {
  const file = await downloadDocumentVersion(ctx, { versionId }, { ...deps, objects: deps.objects ?? configuredDocumentObjects() }); return documentPdfPageCount(file.bytes);
}
export async function readSignaturePreparationTarget(actor: DocumentActorContext, raw: unknown, deps: SignaturePreparationDependencies) {
  const ctx = documentActorContext(actor), input = signaturePreparationTargetInput.parse(raw), first = await withTenant(deps.db, ctx.organizationId, tx => signaturePreparationTargetContext(ctx, tx, input.signatureId, "view", deps.env)), pages = await actualPages(ctx, first.current.version.id, deps);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await signaturePreparationTargetContext(ctx, tx, input.signatureId, "view", deps.env); if (current.fingerprint !== first.fingerprint) throw new DocumentConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.preparation_target_read", resourceType: "signature", resourceId: current.row.id,
      after: { signatureId: current.row.id, versionId: current.current.version.id, recipientCount: current.recipients.length, pageCount: pages }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.current.archive.now });
    const final = await signaturePreparationTargetContext(ctx, tx, input.signatureId, "view", deps.env); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError(); return targetView(final, pages);
  });
}
async function inspectPreparation(ctx: DocumentActorContext, draft: Draft, action: "view" | "create", deps: SignaturePreparationDependencies) {
  const first = await withTenant(deps.db, ctx.organizationId, tx => nativeSignaturePreparationContext(ctx, tx, draft, action, deps.env)), pages = await actualPages(ctx, first.current.version.id, deps);
  if (draft.recipients.some(recipient => recipient.fields.some(field => field.page > pages))) throw new DocumentConflictError();
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await nativeSignaturePreparationContext(ctx, tx, draft, action, deps.env); if (current.fingerprint !== first.fingerprint) throw new DocumentConflictError(); return { current, pages, reviewFingerprint: signaturePreparationReviewFingerprint(ctx, draft, current) };
  });
}
export async function reviewSignaturePreparation(actor: DocumentActorContext, raw: unknown, deps: SignaturePreparationDependencies) {
  const ctx = documentActorContext(actor), draft = normalizedPreparationDraft(signaturePreparationDraftSchema.parse(raw)), prepared = await inspectPreparation(ctx, draft, "view", deps);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await nativeSignaturePreparationContext(ctx, tx, draft, "view", deps.env); if (current.fingerprint !== prepared.current.fingerprint) throw new DocumentConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.preparation_reviewed", resourceType: "signature", resourceId: current.row.id,
      after: { signatureId: current.row.id, versionId: current.current.version.id, recipientCount: current.recipients.length, pageCount: prepared.pages }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.current.archive.now });
    const final = await nativeSignaturePreparationContext(ctx, tx, draft, "view", deps.env); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return signaturePreparationReviewSchema.parse({ ...targetView(final, prepared.pages), reviewFingerprint: signaturePreparationReviewFingerprint(ctx, draft, final) });
  });
}
export function originalSignaturePreparation(row: Intent) {
  const snapshot = signaturePreparationSnapshotSchema.parse(row.policySnapshot), original = { organizationId: row.organizationId, actorId: row.requestedBy, input: snapshot.command }, canonical = JSON.stringify(original), draft = normalizedPreparationDraft(snapshot.command);
  const cap = restoreAuthorizationCap(row.authorizationCap);
  if (cap.organizationId !== row.organizationId || cap.userAccountId !== row.requestedBy || commandFingerprint(signaturePreparationCommandSchema.parse(row.input)) !== commandFingerprint(snapshot.command) || canonical !== row.canonicalRequest || commandFingerprint(original) !== row.commandHash || snapshot.commandHash !== row.commandHash || snapshot.command.idempotencyKey !== row.commandKey || snapshot.command.reason !== row.reason || snapshot.command.signatureId !== row.signatureId || snapshot.providerScopeHash !== row.providerScopeHash || row.phase !== "PREPARE") throw new DocumentConflictError();
  return { snapshot, draft };
}
export async function signaturePreparationResult(ctx: DocumentActorContext, tx: TenantTransaction, row: Intent, env?: NodeJS.ProcessEnv) {
  if (row.requestedBy !== ctx.actorId) throw new DocumentAccessError(); const { snapshot, draft } = originalSignaturePreparation(row), original = documentActorContext({ ...ctx, authContext: restoreAuthorizationCap(row.authorizationCap) }),
    current = await nativeSignaturePreparationContext(ctx, tx, draft, "create", env), held = await nativeSignaturePreparationContext(original, tx, draft, "create", env);
  if (current.fingerprint !== held.fingerprint) throw new DocumentConflictError(); const attempt = await current.repository.preparationAttempt(row.signatureId);
  const state = attempt && attempt.intentId !== row.id ? "SUPERSEDED" : attempt?.evidence.some(evidence => evidence.kind === "PREPARED") ? "PREPARED" : attempt ? "UNCERTAIN" : current.fingerprint !== snapshot.contextFingerprint ? "SOURCE_CHANGED" : "ADMITTED";
  return signaturePreparationReceiptSchema.parse({ recorded: true, id: row.id, signatureId: row.signatureId, idempotencyKey: row.commandKey, state });
}
async function otherProtocol(repository: SignaturePreparationRepository, actorId: string, nonce: string) {
  if (await repository.byNonce(actorId, nonce) || await repository.instanceByNonce(actorId, nonce) || await repository.signatureByNonce(actorId, nonce)) throw new DocumentConflictError();
}
export async function admitSignaturePreparation(actor: DocumentActorContext, raw: unknown, deps: SignaturePreparationDependencies) {
  const ctx = documentActorContext(actor), parsed = signaturePreparationCommandSchema.parse(raw), draft = normalizedPreparationDraft(parsed), command = { ...parsed, recipients: draft.recipients },
    canonicalRequest = JSON.stringify({ organizationId: ctx.organizationId, actorId: ctx.actorId, input: command }), commandHash = commandFingerprint({ organizationId: ctx.organizationId, actorId: ctx.actorId, input: command });
  const replay = await withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignaturePreparationRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.preparationByNonce(ctx.actorId, command.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return signaturePreparationResult(ctx, tx, existing, deps.env); } await otherProtocol(repository, ctx.actorId, command.idempotencyKey); return null; });
  if (replay) return replay;
  const rate = await withTenant(deps.db, ctx.organizationId, async tx => { const current = await nativeSignaturePreparationContext(ctx, tx, draft, "create", deps.env); if (signaturePreparationReviewFingerprint(ctx, draft, current) !== command.reviewFingerprint) throw new DocumentConflictError();
    const budget = current.current.archive.policy.value.upload_admission; return consumeRateLimit(tx, ctx.organizationId, { key: "document-signature-prepare:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.current.archive.now }); });
  if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt); const inspected = await inspectPreparation(ctx, draft, "create", deps); if (inspected.reviewFingerprint !== command.reviewFingerprint) throw new DocumentConflictError();
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new SignaturePreparationRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.preparationByNonce(ctx.actorId, command.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return signaturePreparationResult(ctx, tx, existing, deps.env); } await otherProtocol(repository, ctx.actorId, command.idempotencyKey);
    const current = await nativeSignaturePreparationContext(ctx, tx, draft, "create", deps.env); if (current.fingerprint !== inspected.current.fingerprint) throw new DocumentConflictError();
    await repository.lockProviderScope(current.providerScopeHash); const scope = await repository.scope(current.providerScopeHash), now = current.current.archive.now;
    if (!scope) { await repository.appendScope({ scopeHash: current.providerScopeHash, origin: current.policy.value.account.origin, teamId: current.policy.value.account.teamId, policyId: current.policy.id, policyVersion: current.policy.version, claimedBy: ctx.actorId, claimedAt: now });
      await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.provider_scope_claimed", resourceType: "config_rule", resourceId: current.policy.id,
        after: { providerScopeHash: current.providerScopeHash, policyId: current.policy.id }, requestId: deps.requestId ?? randomUUID(), occurredAt: now }); }
    else if (scope.origin !== current.policy.value.account.origin || scope.teamId !== current.policy.value.account.teamId) throw new DocumentConfigurationError();
    const id = randomUUID(), snapshot = signaturePreparationSnapshotSchema.parse({ protocol: signaturePreparationProtocol, schemaVersion: 1, command, commandHash, signatureCommandHash: current.row.commandHash, contextFingerprint: current.fingerprint, contractHash: current.contractHash, document: current.original.snapshot.document, providerPolicy: current.policy,
      providerScopeHash: current.providerScopeHash, recipients: current.recipients.map(({ id, identityHash, fingerprint }) => ({ id, identityHash, fingerprint })) });
    await repository.appendPreparation({ id, signatureId: current.row.id, phase: "PREPARE", commandKey: command.idempotencyKey, commandHash, canonicalRequest, input: documentJson(command), policySnapshot: documentJson(snapshot), authorizationCap: documentJson(captureAuthorizationCap(ctx.authContext)), sourceFingerprint: current.current.archive.native.fingerprint, providerScopeHash: current.providerScopeHash, reason: command.reason, requestedBy: ctx.actorId, requestedAt: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.preparation_requested", resourceType: "signature", resourceId: id,
      after: { signatureId: current.row.id, intentId: id, commandHash, contractHash: current.contractHash }, reason: "Private preparation reason retained with its original native intent", requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await new OutboxRepository(tx, ctx.organizationId).append(signaturePreparationRequested, { intentId: id }, outboxKey(ctx.actorId, command.idempotencyKey), now);
    const final = await nativeSignaturePreparationContext(ctx, tx, draft, "create", deps.env); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError(); const row = await repository.preparation(id); if (!row) throw new DocumentConflictError(); return signaturePreparationResult(ctx, tx, row, deps.env);
  });
}
export async function recoverSignaturePreparation(actor: DocumentActorContext, raw: unknown, deps: SignaturePreparationDependencies) {
  const ctx = documentActorContext(actor), input = documentRecoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignaturePreparationRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey);
    const row = await repository.preparationByNonce(ctx.actorId, input.idempotencyKey); if (row) return signaturePreparationResult(ctx, tx, row, deps.env);
    if (await repository.preparationNonceOwner(input.idempotencyKey) || await repository.signatureNonceOwner(input.idempotencyKey) || await repository.nonceOwner(input.idempotencyKey) || await repository.instanceNonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId); if ([current, ctx.authContext].some(cap => ["signature:view", "signature:create", "document:view"].some(key => !cap.permissions.has(key)))) throw new DocumentAccessError();
    return { recorded: false as const, id: null, idempotencyKey: input.idempotencyKey, state: null };
  });
}
