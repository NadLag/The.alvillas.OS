import { randomUUID } from "node:crypto";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";
import { withTenant } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { DocumentAccessError, DocumentConflictError, DocumentRateLimitError, documentRecoveryInput } from "../domain/document-command";
import { signedArchiveStatusInput, signedArchiveCommandSchema, signedArchiveReviewSchema, signedArchiveReconciliationSchema, signedArchiveReceiptSchema, signedArchiveReconciliationReceiptSchema, signedArchiveProtocol, signedArchiveRequested } from "../domain/document-signed-archive";
import { SignedSignatureRepository } from "../infrastructure/signed-signature-repository";
import { documentActorContext, documentJson, type DocumentActorContext } from "./document-archive";
import { signatureIdentityRecoveryAuthority } from "./document-signature-identity-context";
import { admitOriginalSignedArchive, originalSignedArchive } from "./document-signed-archive-admission";
import { originalSignaturePreparation } from "./document-signature-preparation";
import { readNativeSignatureProviderEvidence } from "./document-signature-provider-evidence";
import { retainedNativeSignatureReadContext } from "./document-signature-history";

type Dependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string };
type Command = NonNullable<Awaited<ReturnType<SignedSignatureRepository["signedReconciliation"]>>>;
export const signedReconciliationOutboxKey = (actorId: string, nonce: string) => "document-signed-archive-reconcile:" + actorId + ":" + nonce;
export function originalSignedReconciliation(row: Command) {
  const snapshot = signedArchiveReconciliationSchema.parse(row.before), cap = restoreAuthorizationCap(snapshot.authorizationCap), canonical = { organizationId: row.organizationId, actorId: row.actorId, input: snapshot.input };
  if (!row.actorId || cap.organizationId !== row.organizationId || cap.userAccountId !== row.actorId || snapshot.input.idempotencyKey !== row.commandKey || snapshot.input.reason !== row.reason || JSON.stringify(canonical) !== snapshot.canonicalRequest || commandFingerprint(canonical) !== row.commandHash) throw new DocumentConflictError();
  return { snapshot, cap };
}
async function context(ctx: DocumentActorContext, tx: TenantTransaction, signatureId: string, deps: Dependencies, edit = false) {
  const current = await (edit ? signatureIdentityRecoveryAuthority(ctx, tx, signatureId, deps) : retainedNativeSignatureReadContext(ctx, tx, signatureId, deps)), repository = new SignedSignatureRepository(tx, ctx.organizationId), archive = await repository.signedArchiveForSignature(signatureId), completion = await repository.completionEvidence(signatureId);
  return { current, repository, archive, completion, fingerprint: commandFingerprint({ current: current.fingerprint, signature: current.row.commandHash, completion: completion?.payloadSha256 ?? null, archive: archive?.commandHash ?? null }) };
}
async function receipt(current: Awaited<ReturnType<typeof context>>, env?: NodeJS.ProcessEnv) {
  const archive = current.archive, signed = archive?.evidence.find(row => row.kind === "SIGNED"), signedFile = archive?.artifacts.find(row => row.kind === "SIGNED_ORIGINAL"), certificate = archive?.artifacts.find(row => row.kind === "CERTIFICATE");
  if (signed && archive) {
    const snapshot = originalSignedArchive(archive), intent = await current.repository.preparation(snapshot.preparation.intentId); if (!intent) throw new DocumentConflictError(); const original = originalSignaturePreparation(intent), value = readNativeSignatureProviderEvidence(intent, signed, original.snapshot, env), proof = value.signedArchive;
    if (value.kind !== "SIGNED" || !proof || proof.id !== archive.id || proof.signedVersionId !== signedFile?.admission.version?.id || proof.certificateVersionId !== certificate?.admission.version?.id || proof.signedSha256 !== signedFile?.admission.sha256 || proof.certificateSha256 !== certificate?.admission.sha256) throw new DocumentConflictError();
  }
  return signedArchiveReceiptSchema.parse({ signatureId: current.current.row.id, archiveId: archive?.id ?? null, state: signed ? "COMPLETE" : archive || current.completion ? "PENDING" : "AWAITING_COMPLETION", signedDocumentId: signed ? signedFile?.documentId : null, certificateDocumentId: signed ? certificate?.documentId : null, signedVersionId: signed ? signedFile?.admission.version?.id : null, certificateVersionId: signed ? certificate?.admission.version?.id : null });
}
const reviewFingerprint = (ctx: DocumentActorContext, current: Awaited<ReturnType<typeof context>>) => commandFingerprint({ actorId: ctx.actorId, scope: current.fingerprint, cap: captureAuthorizationCap(ctx.authContext) });
export async function reviewSignedArchive(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = signedArchiveStatusInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => { const current = await context(ctx, tx, input.signatureId, deps), result = await receipt(current, deps.env); let canReconcile = true; try { await signatureIdentityRecoveryAuthority(ctx, tx, input.signatureId, deps); } catch (error) { if (!(error instanceof DocumentAccessError)) throw error; canReconcile = false; }
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.signed_archive_reviewed", resourceType: "signature", resourceId: input.signatureId, after: { signatureId: input.signatureId, archiveId: result.archiveId, state: result.state }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.current.current.archive.now });
    if ((await context(ctx, tx, input.signatureId, deps, canReconcile)).fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return signedArchiveReviewSchema.parse({ signatureId: input.signatureId, reviewFingerprint: reviewFingerprint(ctx, current), title: current.current.current.version.title, originalVersionId: current.current.row.documentVersionId, canReconcile, receipt: result }); });
}
async function commandResult(ctx: DocumentActorContext, tx: TenantTransaction, row: Command, deps: Dependencies) {
  if (row.actorId !== ctx.actorId) throw new DocumentAccessError(); const { snapshot, cap } = originalSignedReconciliation(row), current = await context(ctx, tx, snapshot.input.signatureId, deps, true), held = await context(documentActorContext({ ...ctx, authContext: cap }), tx, snapshot.input.signatureId, deps, true);
  if (current.fingerprint !== held.fingerprint || current.archive?.id !== snapshot.archiveId || row.documentId !== current.current.current.instance.documentId) throw new DocumentConflictError();
  return signedArchiveReconciliationReceiptSchema.parse({ recorded: true, id: row.id, idempotencyKey: row.commandKey, receipt: await receipt(current, deps.env) });
}
export async function reconcileSignedArchive(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = signedArchiveCommandSchema.parse(raw), canonical = { organizationId: ctx.organizationId, actorId: ctx.actorId, input }, commandHash = commandFingerprint(canonical);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new SignedSignatureRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey); const existing = await repository.signedReconciliationByNonce(ctx.actorId, input.idempotencyKey);
    if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return commandResult(ctx, tx, existing, deps); }
    if (await repository.providerPreparationByNonce(ctx.actorId, input.idempotencyKey) || await repository.byNonce(ctx.actorId, input.idempotencyKey) || await repository.instanceByNonce(ctx.actorId, input.idempotencyKey) || await repository.signatureByNonce(ctx.actorId, input.idempotencyKey)) throw new DocumentConflictError();
    const current = await context(ctx, tx, input.signatureId, deps, true); if (reviewFingerprint(ctx, current) !== input.reviewFingerprint) throw new DocumentConflictError();
    const budget = current.current.current.archive.policy.value.upload_admission, now = current.current.current.archive.now, rate = await consumeRateLimit(tx, ctx.organizationId, { key: "document-signed-archive-reconcile:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now }); if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt);
    if (!current.completion) return signedArchiveReconciliationReceiptSchema.parse({ recorded: false, id: null, idempotencyKey: input.idempotencyKey, receipt: await receipt(current, deps.env) });
    const archive = current.archive ?? await admitOriginalSignedArchive(tx, repository, current.completion, deps), before = signedArchiveReconciliationSchema.parse({ protocol: signedArchiveProtocol, input, authorizationCap: documentJson(captureAuthorizationCap(ctx.authContext)), canonicalRequest: JSON.stringify(canonical), archiveId: archive.id }), after = { signatureId: input.signatureId, archiveId: archive.id }, id = randomUUID();
    await repository.appendAction({ id, documentId: current.current.current.instance.documentId, action: "SIGNED_ARCHIVE_RECONCILED", commandKey: input.idempotencyKey, commandHash, sourceFingerprint: current.fingerprint, reason: input.reason, before: documentJson(before), after, actorId: ctx.actorId, occurredAt: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signed_archive_reconciled", resourceType: "document", resourceId: id, after: { documentId: current.current.current.instance.documentId, ...after, commandHash }, reason: "Private reconciliation reason retained in document history", requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await new OutboxRepository(tx, ctx.organizationId).append(signedArchiveRequested, { archiveId: archive.id, reconciliationId: id }, signedReconciliationOutboxKey(ctx.actorId, input.idempotencyKey), now);
    const final = await context(ctx, tx, input.signatureId, deps, true); if (final.current.fingerprint !== current.current.fingerprint || final.completion?.payloadSha256 !== current.completion.payloadSha256) throw new DocumentConflictError(); const row = await repository.signedReconciliation(id); if (!row) throw new DocumentConflictError(); return commandResult(ctx, tx, row, deps);
  });
}
export async function recoverSignedArchive(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = documentRecoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignedSignatureRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey); const row = await repository.signedReconciliationByNonce(ctx.actorId, input.idempotencyKey); if (row) return commandResult(ctx, tx, row, deps);
    if (await repository.signedReconciliationNonceOwner(input.idempotencyKey) || await repository.preparationNonceOwner(input.idempotencyKey) || await repository.signatureNonceOwner(input.idempotencyKey) || await repository.nonceOwner(input.idempotencyKey) || await repository.instanceNonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const actual = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId); if ([actual, ctx.authContext].some(cap => ["signature:view", "signature:edit", "document:view"].some(key => !cap.permissions.has(key)))) throw new DocumentAccessError(); return signedArchiveReconciliationReceiptSchema.parse({ recorded: false, id: null, idempotencyKey: input.idempotencyKey, receipt: null }); });
}
