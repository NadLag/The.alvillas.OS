import { createHash, randomUUID } from "node:crypto";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { DocumentRepository } from "../infrastructure/document-repository";
import { encodeDocumentGenerationInput, sealDocumentGenerationInput } from "../infrastructure/document-generation-payload";
import { documentGenerationCommandSchema, documentGenerationSnapshotSchema, documentGenerationReceiptSchema, documentGenerationProtocol, documentGenerationRequested } from "../domain/document-generation";
import { documentRecoveryInput, documentSourceReferenceSchema, DocumentAccessError, DocumentConflictError, DocumentRateLimitError } from "../domain/document-command";
import { documentActorContext, documentArchiveContext, appendDocumentHistory, documentJson, type DocumentActorContext } from "./document-archive";
import { prepareDocumentGeneration,documentGenerationTarget } from "./document-generation-review";
import {generatedDocumentUploadInput} from "../domain/document-generated-upload";

type Dependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string };
type Instance = NonNullable<Awaited<ReturnType<DocumentRepository["instance"]>>>;
const sourceOf = (row: Instance) => documentSourceReferenceSchema.parse({ kind: row.document.sourceKind, id: row.document.sourceId });
export const documentGenerationOutboxKey = (actorId: string, nonce: string) => "document-generation:" + actorId + ":" + nonce;

export async function documentGenerationResult(ctx: DocumentActorContext, tx: TenantTransaction, row: Instance) {
  if (row.createdBy !== ctx.actorId) throw new DocumentAccessError();
  const snapshot = documentGenerationSnapshotSchema.parse(row.sourceSnapshot), original = documentActorContext({ ...ctx, authContext: restoreAuthorizationCap(snapshot.authorizationCap) }), repository = new DocumentRepository(tx, ctx.organizationId), admission = await repository.byNonce(row.createdBy,row.commandKey),version=admission?.version??null;
  if(admission&&(admission.documentId!==row.documentId||admission.commandHash!==row.commandHash||generatedDocumentUploadInput.parse(admission.input).generationInstanceId!==row.id))throw new DocumentConflictError();
  let state: "PENDING" | "COMPLETE" | "SOURCE_CHANGED" = version ? "COMPLETE" : "PENDING";
  try {
    const current = await documentArchiveContext(ctx, tx, sourceOf(row), version ? "view" : "create", row.document), held = await documentArchiveContext(original, tx, sourceOf(row), version ? "view" : "create", row.document);
    if (current.fingerprint !== held.fingerprint) throw new DocumentConflictError();
  } catch (error) {
    if (version || !(error instanceof DocumentConflictError)) throw error;
    const current = await documentArchiveContext(ctx, tx, sourceOf(row), "view", row.document), held = await documentArchiveContext(original, tx, sourceOf(row), "view", row.document);
    if (current.fingerprint !== held.fingerprint) throw new DocumentConflictError(); state = "SOURCE_CHANGED";
  }
  return documentGenerationReceiptSchema.parse({ recorded: true, id: row.id, documentId: row.documentId, idempotencyKey: row.commandKey, state, versionId: version?.id ?? null });
}

/** The immutable instance and reference-only outbox commit before PDF/provider/storage I/O. */
export async function admitDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), parsed = documentGenerationCommandSchema.parse(raw), command = { ...parsed, variantVersionIds: [...parsed.variantVersionIds].sort() }, commandHash = commandFingerprint(command),
    draft = { templateVersionId: command.templateVersionId, variantVersionIds: command.variantVersionIds, source: command.source, title: command.title, effectiveFrom: command.effectiveFrom,
      ...command.documentId!==undefined?{documentId:command.documentId}:{},...command.supersedesId!==undefined?{supersedesId:command.supersedesId}:{} };
  const replay = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.instanceByNonce(ctx.actorId, command.idempotencyKey);
    if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return documentGenerationResult(ctx, tx, existing); }
    if (await repository.byNonce(ctx.actorId, command.idempotencyKey) || await repository.signatureByNonce(ctx.actorId, command.idempotencyKey) || await repository.providerPreparationByNonce(ctx.actorId, command.idempotencyKey)) throw new DocumentConflictError(); return null;
  });
  if (replay) return replay;
  const prepared = await prepareDocumentGeneration(ctx, draft, deps); if (prepared.reviewFingerprint !== command.reviewFingerprint) throw new DocumentConflictError();
  const rate = await withTenant(deps.db, ctx.organizationId, async tx => {
    const {current}=await documentGenerationTarget(ctx,tx,draft,prepared.selected,prepared.renderInput.source.privacy),budget = current.policy.value.upload_admission;
    return consumeRateLimit(tx, ctx.organizationId, { key: "document-archive:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.now });
  });
  if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    if(draft.documentId)await repository.lock("root:"+draft.documentId);
    const existing = await repository.instanceByNonce(ctx.actorId, command.idempotencyKey);
    if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return documentGenerationResult(ctx, tx, existing); }
    if (await repository.byNonce(ctx.actorId, command.idempotencyKey) || await repository.signatureByNonce(ctx.actorId, command.idempotencyKey) || await repository.providerPreparationByNonce(ctx.actorId, command.idempotencyKey)) throw new DocumentConflictError();
    let target=await documentGenerationTarget(ctx,tx,draft,prepared.selected,prepared.renderInput.source.privacy),current=target.current,root=target.root;
    if (current.fingerprint!==prepared.targetFingerprint||current.native.fingerprint !== prepared.nativeSourceFingerprint || commandFingerprint(current.policy) !== commandFingerprint(prepared.policySnapshot)) throw new DocumentConflictError();
    const id = randomUUID(),documentId=root?.id??randomUUID();
    if(root){
      if(current.privacy.some(value=>!root!.privacy.includes(value))){const before=await repository.snapshot(root.id);if(!before)throw new DocumentAccessError();root=await repository.protect(root.id,root.revision,current.privacy);
        await appendDocumentHistory(ctx,tx,current,root.id,"CLASSIFICATION_STRENGTHENED",command.idempotencyKey,commandHash,command.reason,before,{document:await repository.snapshot(root.id)},deps);
        target=await documentGenerationTarget(ctx,tx,draft,prepared.selected,prepared.renderInput.source.privacy);current=target.current;root=target.root;if(!root)throw new DocumentConflictError();
      }
    }else{
      root=await repository.appendDocument({ id: documentId, sourceKind: draft.source.kind, sourceId: draft.source.id, propertyId: draft.source.kind === "PROPERTY" ? draft.source.id : null,
      ownerId: draft.source.kind === "OWNER" ? draft.source.id : null, reservationId: draft.source.kind === "RESERVATION" ? draft.source.id : null, personId: draft.source.kind === "PERSON" ? draft.source.id : null,
      transactionId: draft.source.kind === "FINANCIAL_TRANSACTION" ? draft.source.id : null, typeKey: prepared.selected.typeKey, kind: "INSTANCE", locale: prepared.selected.locale, title: draft.title,
      privacy: current.privacy, sourceSnapshot: documentJson(current.native.snapshot), policySnapshot: documentJson(current.policy), commandKey: command.idempotencyKey, commandHash, createdBy: ctx.actorId, createdAt: current.now });
      await appendDocumentHistory(ctx, tx, current, root.id, "CREATED", command.idempotencyKey, commandHash, command.reason, {}, { document: await repository.snapshot(root.id) }, deps);
    }
    const bytes = encodeDocumentGenerationInput(prepared.renderInput),identity = { organizationId: ctx.organizationId, documentId, instanceId: id,
      templateVersionId: prepared.selected.versionId, templateSha256: prepared.selected.sha256, sourceFingerprint: prepared.sourceFingerprint, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length },
      snapshot = documentGenerationSnapshotSchema.parse({ protocol: documentGenerationProtocol, schemaVersion: 1, identity, command, commandHash, nativeSourceFingerprint: prepared.nativeSourceFingerprint,
        policySnapshot: current.policy, authorizationCap: captureAuthorizationCap(ctx.authContext), variants: prepared.variants, contractFingerprint: prepared.contractFingerprint,documentRevision:root.revision.toString(),
        sourceKeys: prepared.selected.definition.variables.map(variable => variable.key), payloadCipher: sealDocumentGenerationInput(identity, bytes, deps.env).toString("base64") });
    await repository.appendInstance({ id, documentId, templateVersionId: prepared.selected.versionId, sourceSnapshot: documentJson(snapshot), sourceFingerprint: prepared.sourceFingerprint,
      commandKey: command.idempotencyKey, commandHash, createdBy: ctx.actorId, createdAt: current.now });
    await appendDocumentHistory(ctx, tx, current, root.id, "INSTANCE_CREATED", command.idempotencyKey, commandHash, command.reason, {}, { documentId, instanceId: id, templateVersionId: prepared.selected.versionId,...draft.supersedesId?{supersedesId:draft.supersedesId}:{} }, deps);
    await new OutboxRepository(tx, ctx.organizationId).append(documentGenerationRequested, { instanceId: id }, documentGenerationOutboxKey(ctx.actorId, command.idempotencyKey), current.now);
    const row = await repository.instance(id); if (!row) throw new DocumentConflictError();
    await documentArchiveContext(ctx, tx, draft.source, "create", row.document); return documentGenerationResult(ctx, tx, row);
  });
}

export async function recoverDocumentGeneration(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = documentRecoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey);
    const row = await repository.instanceByNonce(ctx.actorId, input.idempotencyKey); if (row) return documentGenerationResult(ctx, tx, row);
    if (await repository.instanceNonceOwner(input.idempotencyKey) || await repository.nonceOwner(input.idempotencyKey) || await repository.signatureNonceOwner(input.idempotencyKey) || await repository.providerPreparationNonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
    if ([ctx.authContext, current].some(authority => ["document:view", "document_instance:view", "document_instance:create"].some(key => !authority.permissions.has(key)))) throw new DocumentAccessError();
    return { recorded: false as const, id: null, documentId: null, idempotencyKey: input.idempotencyKey, state: null, versionId: null };
  });
}
