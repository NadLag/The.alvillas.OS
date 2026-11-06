import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Action, AuthContext, DataClass } from "@/platform/authz/authorize";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentRepository, type DocumentSourceFacts } from "../infrastructure/document-repository";
import type { DocumentObjectStore } from "../infrastructure/document-object-store";
import { documentObjectKey } from "../domain/document-object";
import { documentPartContract,documentUploadChunkBytes } from "../domain/document-upload-parts";
import { documentArchivePolicyKey, documentArchivePolicySchema, retainDocumentPrivacy, type DocumentTypePolicy } from "../domain/document-policy";
import { documentUploadReviewInput, documentUploadInput, documentRecoveryInput, documentSourceReferenceSchema,
  DocumentAccessError, DocumentConfigurationError, DocumentConflictError,DocumentRateLimitError } from "../domain/document-command";
import { documentItemSchema, documentVersionItemSchema, documentHistorySchema, documentUploadAdmissionSchema,documentPartReceiptSchema } from "../domain/document-read-model";
import { documentTemplateMediaType } from "../domain/document-template-format";
import { decodeDocumentTemplate } from "../domain/document-template";
import { documentGenerationProtocol, documentGenerationSnapshotSchema } from "../domain/document-generation";
import { DocumentTemplateSourceRepository } from "../infrastructure/document-template-source-repository";
import { validateDocumentTemplateBytes, sealDocumentTemplatePayload, openDocumentTemplatePayload } from "../infrastructure/document-template-payload";

export type DocumentActorContext = { organizationId: string; actorId: string; authContext: AuthContext };
type Dependencies = { db: TenantTransactionRunner; objects?: DocumentObjectStore; requestId?: string; preparedTemplate?:Uint8Array; env?:NodeJS.ProcessEnv };
type Root = NonNullable<Awaited<ReturnType<DocumentRepository["document"]>>>;
type Admission = NonNullable<Awaited<ReturnType<DocumentRepository["admission"]>>>;
type Version = NonNullable<Awaited<ReturnType<DocumentRepository["version"]>>>;
type ReviewInput = z.infer<typeof documentUploadReviewInput>;
const savedPolicy = z.object({ id: z.uuid(), version: z.number().int().positive(), value: documentArchivePolicySchema }).strict();
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function actorContext(actor: DocumentActorContext): DocumentActorContext {
  if (actor.organizationId !== actor.authContext.organizationId || actor.actorId !== actor.authContext.userAccountId) throw new DocumentAccessError();
  return { ...actor, authContext: restoreAuthorizationCap(captureAuthorizationCap(actor.authContext)) };
}
export { actorContext as documentActorContext };
function sourceOf(root: Root) { return documentSourceReferenceSchema.parse({ kind: root.sourceKind, id: root.sourceId }); }
export function documentAuthorityChecks(native: DocumentSourceFacts, privacy: readonly string[], action: Action, root?: Pick<Root, "kind"> & { id?: string; createdBy?: string }): CurrentAuthorityCheck[] {
  const checks = [...native.checks], source = native.resource;
  for (const dataClass of privacy) {
    const resource = { ...source, type: "document", id: root?.id, documentId: root?.id, assignedUserAccountId: root?.createdBy ?? source.assignedUserAccountId, dataClass: dataClass as DataClass };
    checks.push({ action: "view", resource }, ...(action === "view" ? [] : [{ action, resource }]));
    if (root?.kind === "TEMPLATE") checks.push({ action: "view", resource: { ...resource, type: "document_template" } }, ...(action === "view" ? [] : [{ action, resource: { ...resource, type: "document_template" } }]));
    if (root?.kind === "INSTANCE") checks.push({ action: "view", resource: { ...resource, type: "document_instance" } }, ...(action === "view" ? [] : [{ action, resource: { ...resource, type: "document_instance" } }]));
    if (dataClass === "financial" && native.reference.kind !== "FINANCIAL_TRANSACTION") {
      const type = native.reference.kind === "PERSON" ? "staff_compensation" : source.propertyId ? "property_finance" : source.ownerId ? "owner_statement" : "company_ledger";
      const financial = { ...source, type, dataClass: "financial" as const };
      checks.push({ action: "view", resource: financial, organizationOnly: !source.propertyId && !source.ownerId },
        ...(action === "export" ? [{ action, resource: financial, organizationOnly: !source.propertyId && !source.ownerId }] : []));
    }
  }
  return checks;
}
export async function documentSourceContext(ctx: DocumentActorContext, tx: TenantTransaction, reference: z.infer<typeof documentSourceReferenceSchema>, action: "view" | "create" | "export") {
  const repository = new DocumentRepository(tx, ctx.organizationId), now = await repository.clock(), native = await repository.documentSource(reference, action === "export" ? "export" : "view");
  if (!native) throw new DocumentAccessError();
  await recheckAccountAuthorization(ctx, tx, now, native.checks, new DocumentAccessError());
  const source = native.resource, rule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: documentArchivePolicyKey, asOf: now, scopes: [
    { scopeType: "organization", scopeId: null }, ...(source.city ? [{ scopeType: "city", scopeId: source.city }] : []),
    ...(source.ownerId ? [{ scopeType: "owner", scopeId: source.ownerId }] : []), ...(source.propertyId ? [{ scopeType: "property", scopeId: source.propertyId }] : [])] });
  const value = documentArchivePolicySchema.safeParse(rule?.value); if (!rule || !value.success) throw new DocumentConfigurationError();
  const policy = { id: rule.id, version: rule.version, value: value.data };
  return { repository, now, native, policy };
}
type ArchiveContext = Awaited<ReturnType<typeof documentSourceContext>> & { type: DocumentTypePolicy | undefined; privacy: ReturnType<typeof retainDocumentPrivacy>; checks: CurrentAuthorityCheck[]; fingerprint: string };
type CreationIntent = { typeKey: string; kind: "FILE" | "TEMPLATE" | "INSTANCE"; privacy?: readonly string[] };
async function context(ctx: DocumentActorContext, tx: TenantTransaction, reference: z.infer<typeof documentSourceReferenceSchema>, action: "view" | "create" | "export", root?: Root, prospective?: CreationIntent): Promise<ArchiveContext> {
  const generating = action === "create" && (root?.kind ?? prospective?.kind) === "INSTANCE";
  const base = await documentSourceContext(ctx, tx, reference, generating ? "export" : action), { repository, now, native, policy } = base;
  const type = policy.value.types.find(type => type.key === (prospective?.typeKey ?? root?.typeKey));
  if (action === "create" && (!type || !type.sources.includes(reference.kind) || native.archived || root?.archivedAt)) throw new DocumentConfigurationError();
  const originPrivacy: string[] = [], originChecks: CurrentAuthorityCheck[] = [], origins: { versionId: string; fingerprint: string }[] = [];
  const parsed = root?.kind === "INSTANCE" && root.instance ? documentGenerationSnapshotSchema.safeParse(root.instance.sourceSnapshot) : null,
    generation = parsed?.success ? parsed.data : null;
  if (root?.kind === "INSTANCE") {
    if (!root.instance) throw new DocumentAccessError();
    const snapshot = root.instance.sourceSnapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && snapshot.protocol === documentGenerationProtocol && !generation) throw new DocumentConflictError();
    if (generation && (generation.identity.organizationId !== ctx.organizationId || generation.identity.documentId !== root.id || generation.identity.instanceId !== root.instance.id || generation.authorizationCap.userAccountId !== root.instance.createdBy)) throw new DocumentConflictError();
    const references = generation?.variants ?? [{ versionId: root.instance.templateVersionId }];
    for (const reference of references) {
      const version = await repository.version(reference.versionId), template = version ? await repository.document(version.documentId) : null;
      if (!version || !template || template.kind !== "TEMPLATE") throw new DocumentAccessError();
      const origin = await context(ctx, tx, sourceOf(template), action === "view" ? "view" : "export", template);
      originPrivacy.push(...origin.privacy); originChecks.push(...origin.checks); origins.push({ versionId: version.id, fingerprint: origin.fingerprint });
      if (generation && action === "create") {
        const original = generation.variants.find(item => item.versionId === version.id);
        if (!original || original.documentId !== template.id || original.sha256 !== version.admission.sha256 || original.fingerprint !== origin.fingerprint || template.archivedAt || origin.native.archived) throw new DocumentConflictError();
      }
    }
  }
  const privacy = retainDocumentPrivacy(root?.privacy ?? [], [...type?.privacy ?? [], ...prospective?.privacy ?? [], ...originPrivacy], reference.kind);
  if (!privacy.length) throw new DocumentAccessError();
  const checks = [...documentAuthorityChecks(native, privacy, action, root ?? (prospective ? { kind: prospective.kind, createdBy: ctx.actorId } : undefined)), ...originChecks];
  if (generating) checks.push(...documentAuthorityChecks(native, privacy, "export", root ?? (prospective ? { kind: prospective.kind, createdBy: ctx.actorId } : undefined)));
  await recheckAccountAuthorization(ctx, tx, now, checks, new DocumentAccessError());
  if (generation && action === "create") {
    const values = await new DocumentTemplateSourceRepository(tx, ctx.organizationId).templateSourceValues(native, generation.sourceKeys);
    if (values.fingerprint !== generation.identity.sourceFingerprint || native.fingerprint !== generation.nativeSourceFingerprint || commandFingerprint(policy) !== commandFingerprint(generation.policySnapshot)) throw new DocumentConflictError();
  }
  if (origins.length) await recheckAccountAuthorization(ctx, tx, await repository.clock(), checks, new DocumentAccessError());
  return { repository, now, native, policy, type, privacy, checks,
    fingerprint: commandFingerprint({ source: native.fingerprint, policy, privacy, revision: root?.revision.toString() ?? null, archivedAt: root?.archivedAt ?? null, ...origins.length ? { origins } : {} }) };
}
export { context as documentArchiveContext, historyAction as appendDocumentHistory, json as documentJson };
async function review(ctx: DocumentActorContext, tx: TenantTransaction, input: ReviewInput) {
  const repository = new DocumentRepository(tx, ctx.organizationId), root = input.documentId ? await repository.document(input.documentId) : null;
  if (input.documentId && !root) throw new DocumentAccessError();
  if (root && (root.sourceKind !== input.source.kind || root.sourceId !== input.source.id || root.typeKey !== input.typeKey || root.kind !== input.kind || root.locale !== input.locale || (root.template?.key ?? null) !== input.templateKey)) throw new DocumentConflictError();
  const current = await context(ctx, tx, input.source, "create", root ?? undefined, input), previous = root ? await repository.latest(root.id) : null;
  if (!current.type?.content_types.includes(input.contentType) || input.fileSize > current.type.max_bytes || (previous?.id ?? null) !== input.supersedesId) throw new DocumentConflictError();
  if(input.parts&&!current.policy.value.upload_transport)throw new DocumentConfigurationError();
  return { ...current, root, previous, reviewFingerprint: commandFingerprint({ actorId: ctx.actorId, input, source: current.fingerprint, latest: previous?.id ?? null, cap: captureAuthorizationCap(ctx.authContext) }) };
}
function publicVersion(ctx: DocumentActorContext, current: Awaited<ReturnType<typeof context>>, root: Root, row: Version) {
  const data = { id: row.id, documentId: row.documentId, number: row.number, title: row.title, fileName: row.admission.fileName,
    contentType: row.admission.contentType, fileSize: row.admission.fileSize, sha256: row.admission.sha256,
    supersedesId: row.supersedesId, supersededById: row.next[0]?.id ?? null, effectiveFrom: row.effectiveFrom?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), createdBy: row.createdBy, reason: row.admission.reason };
  return documentVersionItemSchema.parse(present({ ...ctx.authContext, visibleDataClasses: new Set<DataClass>(current.privacy) }, "view",
    { ...current.native.resource, type: "document", id: root.id, documentId: root.id, assignedUserAccountId: root.createdBy, data }, Object.fromEntries(Object.keys(data).map(key => [key, { dataClass: current.privacy[0] }])), current.now));
}
async function historyAction(ctx: DocumentActorContext, tx: TenantTransaction, current: Awaited<ReturnType<typeof context>>, rootId: string,
  action: string, commandKey: string, commandHash: string, reason: string, before: Prisma.InputJsonValue, after: Prisma.InputJsonValue, deps: Dependencies) {
  const row = await current.repository.appendAction({ documentId: rootId, action, commandKey, commandHash, reason, before, after,
    sourceFingerprint: current.native.fingerprint, actorId: ctx.actorId, occurredAt: current.now });
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents." + action.toLowerCase(), resourceType: "document", resourceId: row.id,
    after: { documentId: rootId, commandHash }, reason: "Private document reason retained in the authorized document history", requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
}
function identity(ctx: DocumentActorContext, row: Pick<Admission, "id" | "documentId" | "contentType" | "fileSize" | "sha256">) {
  return { organizationId: ctx.organizationId, documentId: row.documentId, admissionId: row.id, contentType: row.contentType as z.infer<typeof documentUploadInput>["contentType"], fileSize: row.fileSize, sha256: row.sha256 };
}
async function admittedContext(ctx: DocumentActorContext, tx: TenantTransaction, row: Admission) {
  if (row.createdBy !== ctx.actorId) throw new DocumentAccessError();
  const root = await new DocumentRepository(tx, ctx.organizationId).document(row.documentId); if (!root) throw new DocumentAccessError();
  const latest = row.version ? null : await new DocumentRepository(tx,ctx.organizationId).latest(root.id);
  const superseded = !row.version && ((latest?.id ?? null) !== row.supersedesId || root.revision !== row.expectedRevision);
  const original = { ...ctx, authContext: restoreAuthorizationCap(row.authorizationCap) }, action = row.version || superseded ? "view" : "create";
  const current = await context(ctx, tx, sourceOf(root), action, root), held = await context(original, tx, sourceOf(root), action, root);
  if (!row.version && !superseded && (row.sourceFingerprint !== current.native.fingerprint || commandFingerprint(savedPolicy.parse(row.policySnapshot)) !== commandFingerprint(current.policy))) throw new DocumentConflictError();
  if (current.fingerprint !== held.fingerprint) throw new DocumentConflictError(); return { ...current, root, superseded };
}
async function admissionResult(ctx: DocumentActorContext, tx: TenantTransaction, row: Admission) {
  const current = await admittedContext(ctx, tx, row);
  return documentUploadAdmissionSchema.parse({ recorded: true, id: row.id, documentId: row.documentId, idempotencyKey: row.commandKey, state: row.version ? "COMPLETE" : current.superseded ? "SUPERSEDED" : "ADMITTED", complete: Boolean(row.version), version: row.version ? publicVersion(ctx, current, current.root, row.version) : null,
    expected: { fileName: row.fileName, contentType: row.contentType, fileSize: row.fileSize, sha256: row.sha256,parts:documentUploadInput.parse(row.input).parts??null } });
}

export async function reviewDocumentUpload(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = actorContext(actor), input = documentUploadReviewInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => { const current = await review(ctx, tx, input);
    return { reviewFingerprint: current.reviewFingerprint, privacy: current.privacy, number: (current.previous?.number ?? 0) + 1 }; });
}

/** Durable admission commits before any object I/O; the browser retains only its nonce. */
export async function admitDocumentUpload(actor: DocumentActorContext, raw: unknown, deps: Dependencies):Promise<z.infer<typeof documentUploadAdmissionSchema>> {
  const ctx = actorContext(actor), input = documentUploadInput.parse(raw), inputReview = documentUploadReviewInput.parse(Object.fromEntries(Object.entries(input).filter(([key]) => !["idempotencyKey", "reviewFingerprint", "reason"].includes(key)))), commandHash = commandFingerprint(input);
  const prepared=deps.preparedTemplate?Buffer.from(deps.preparedTemplate):null;
  if(prepared){if(input.contentType!==documentTemplateMediaType||!input.templateKey)throw new DocumentConflictError();validateDocumentTemplateBytes({...input,templateKey:input.templateKey},prepared);}
  const rate = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), existing = await repository.byNonce(ctx.actorId, input.idempotencyKey);
    if (await repository.instanceByNonce(ctx.actorId, input.idempotencyKey)) throw new DocumentConflictError();
    if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return { kind:"recovered" as const,receipt:await admissionResult(ctx, tx, existing) }; }
    if(input.contentType===documentTemplateMediaType&&!prepared)throw new DocumentConfigurationError();
    const current = await review(ctx, tx, inputReview); if (current.reviewFingerprint !== input.reviewFingerprint) throw new DocumentConflictError();
    const budget = current.policy.value.upload_admission;
    const decision = await consumeRateLimit(tx, ctx.organizationId, { key: "document-archive:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.now });
    return { kind:"rate" as const,allowed: decision.allowed,resetAt:decision.resetAt };
  });
  if (rate.kind==="recovered") return rate.receipt;
  if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey);
    if (await repository.instanceByNonce(ctx.actorId, input.idempotencyKey)) throw new DocumentConflictError();
    const existing = await repository.byNonce(ctx.actorId, input.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return admissionResult(ctx, tx, existing); }
    if (input.documentId) await repository.lock("root:" + input.documentId);
    const current = await review(ctx, tx, inputReview); if (current.reviewFingerprint !== input.reviewFingerprint) throw new DocumentConflictError();
    let root = current.root;
    if (!root) {
      root = await repository.appendDocument({ sourceKind: input.source.kind, sourceId: input.source.id, propertyId: input.source.kind === "PROPERTY" ? input.source.id : null,
        ownerId: input.source.kind === "OWNER" ? input.source.id : null, reservationId: input.source.kind === "RESERVATION" ? input.source.id : null,
        personId: input.source.kind === "PERSON" ? input.source.id : null, transactionId: input.source.kind === "FINANCIAL_TRANSACTION" ? input.source.id : null,
        typeKey: input.typeKey, kind: input.kind, locale: input.locale, title: input.title, privacy: current.privacy, sourceSnapshot: json(current.native.snapshot), policySnapshot: json(current.policy),
        commandKey: input.idempotencyKey, commandHash, createdBy: ctx.actorId, createdAt: current.now });
      await historyAction(ctx, tx, current, root.id, "CREATED", input.idempotencyKey, commandHash, input.reason, {}, { document: await repository.snapshot(root.id) }, deps);
      if (input.kind === "TEMPLATE" && input.templateKey) {
        await repository.appendTemplate({ documentId: root.id, key: input.templateKey, locale: input.locale, createdBy: ctx.actorId, createdAt: current.now });
        await historyAction(ctx, tx, current, root.id, "TEMPLATE_CREATED", input.idempotencyKey, commandHash, input.reason, {}, { documentId: root.id }, deps);
      }
    }
    const before = await repository.snapshot(root.id), changed = root.privacy.join("\0") !== current.privacy.join("\0");
    if (changed) root = await repository.protect(root.id, root.revision, current.privacy);
    const id = randomUUID(), objectIdentity = identity(ctx, { ...input, id, documentId: root.id });
    const payloadCipher=prepared&&input.templateKey?sealDocumentTemplatePayload({...objectIdentity,templateKey:input.templateKey,locale:input.locale},prepared,deps.env):null;
    await repository.appendAdmission({ id, documentId: root.id, supersedesId: input.supersedesId, expectedRevision: root.revision,
      authorizationCap: json(captureAuthorizationCap(ctx.authContext)), policySnapshot: json(current.policy), sourceFingerprint: current.native.fingerprint,
      input: json(input), commandKey: input.idempotencyKey, commandHash, fileName: input.fileName, contentType: input.contentType, fileSize: input.fileSize, sha256: input.sha256,
      storageKey: documentObjectKey(objectIdentity), payloadCipher, reason: input.reason, createdBy: ctx.actorId, createdAt: current.now });
    await historyAction(ctx, tx, current, root.id, "ADMITTED", input.idempotencyKey, commandHash, input.reason, changed ? json(before) : {},
      json({ admissionId: id, document: await repository.snapshot(root.id) }), deps);
    const final = await context(ctx, tx, input.source, "create", await repository.document(root.id) ?? undefined, inputReview);
    if (current.native.fingerprint !== final.native.fingerprint || commandFingerprint(current.policy) !== commandFingerprint(final.policy)) throw new DocumentConflictError();
    const row = await repository.admission(id); if (!row) throw new DocumentConflictError(); return admissionResult(ctx, tx, row);
  });
}

export async function recoverDocumentUpload(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = actorContext(actor), input = documentRecoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey);
    if (await repository.instanceNonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const row = await repository.byNonce(ctx.actorId, input.idempotencyKey); if (row) return admissionResult(ctx, tx, row);
    if (await repository.nonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const current = await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    if ([ctx.authContext,current].some(authority => ["document:view","document:create"].some(key => !authority.permissions.has(key)))) throw new DocumentAccessError();
    return { recorded: false as const, id: null, documentId: null, idempotencyKey: input.idempotencyKey, complete: false as const, version: null, expected: null };
  });
}

const uploadReference = z.object({ admissionId: z.uuid() }).strict();
export async function uploadDocumentBytes(actor: DocumentActorContext, raw: unknown, bytes: Uint8Array, deps: Dependencies) {
  const ctx = actorContext(actor), input = uploadReference.parse(raw);
  const captured = await withTenant(deps.db, ctx.organizationId, async tx => {
    const row = await new DocumentRepository(tx, ctx.organizationId).admission(input.admissionId); if (!row) throw new DocumentAccessError();
    const current = await admittedContext(ctx, tx, row);
    if (current.superseded) throw new DocumentConflictError();
    if (bytes.length !== row.fileSize || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new DocumentConflictError();
    const parts=documentUploadInput.parse(row.input).parts;
    if(row.contentType===documentTemplateMediaType){const original=documentUploadInput.parse(row.input);if(!original.templateKey||!row.payloadCipher)throw new DocumentConflictError();validateDocumentTemplateBytes({...identity(ctx,row),templateKey:original.templateKey,locale:original.locale},bytes);}
    if(parts&&parts.hashes.some((hash,index)=>createHash("sha256").update(bytes.subarray(index*documentUploadChunkBytes,(index+1)*documentUploadChunkBytes)).digest("hex")!==hash))throw new DocumentConflictError();
    return { row, ttl: current.policy.value.storage_url_seconds, result: row.version ? await admissionResult(ctx, tx, row) : null };
  });
  if (captured.result) return captured.result;
  if (!deps.objects) throw new DocumentConfigurationError();
  const stored = await deps.objects.put(identity(ctx, captured.row), bytes, captured.ttl);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("root:" + captured.row.documentId);
    const row = await repository.admission(input.admissionId); if (!row) throw new DocumentAccessError();
    const current = await admittedContext(ctx, tx, row);
    if (current.superseded) throw new DocumentConflictError();
    if (!row.version) {
      const previous = await repository.latest(row.documentId); if ((previous?.id ?? null) !== row.supersedesId) throw new DocumentConflictError();
      const originalInput = documentUploadInput.parse(row.input), version = await repository.appendVersion({ documentId: row.documentId, admissionId: row.id, number: (previous?.number ?? 0) + 1,
        title: originalInput.title, supersedesId: row.supersedesId, effectiveFrom: originalInput.effectiveFrom ? new Date(originalInput.effectiveFrom) : null,
        cipherSize: stored.cipherSize, cipherSha256: stored.cipherSha256, keyVersion: stored.keyVersion, createdBy: ctx.actorId, createdAt: current.now });
      await historyAction(ctx, tx, current, row.documentId, "VERSION_ADDED", row.commandKey, row.commandHash, row.reason, {}, { versionId: version.id, admissionId: row.id }, deps);
      const final = await admittedContext(ctx, tx, row); if (current.fingerprint !== final.fingerprint) throw new DocumentConflictError();
    }
    const complete = await repository.admission(row.id); if (!complete?.version) throw new DocumentConflictError(); return admissionResult(ctx, tx, complete);
  });
}

const partReference=z.object({admissionId:z.uuid(),index:z.number().int().min(0)}).strict();
export async function uploadDocumentPart(actor:DocumentActorContext,raw:unknown,bytes:Uint8Array,deps:Dependencies){
  const ctx=actorContext(actor),input=partReference.parse(raw);
  const captured=await withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentRepository(tx,ctx.organizationId),row=await repository.admission(input.admissionId);if(!row)throw new DocumentAccessError();
    const current=await admittedContext(ctx,tx,row),parts=documentUploadInput.parse(row.input).parts;if(!parts||current.superseded)throw new DocumentConflictError();
    const contract=documentPartContract(identity(ctx,row),input.index,parts);
    if(bytes.length!==contract.size||createHash("sha256").update(bytes).digest("hex")!==contract.sha256)throw new DocumentConflictError();
    const budget=current.policy.value.upload_transport;if(!budget)throw new DocumentConfigurationError();
    const decision=await consumeRateLimit(tx,ctx.organizationId,{key:"document-parts:"+ctx.actorId,limit:budget.max_requests,windowSeconds:budget.window_seconds,now:current.now});
    return{row,parts,sha256:contract.sha256,fingerprint:current.fingerprint,ttl:current.policy.value.storage_url_seconds,allowed:decision.allowed,resetAt:decision.resetAt};
  });
  if(!captured.allowed)throw new DocumentRateLimitError(captured.resetAt);
  if(!captured.row.version){if(!deps.objects)throw new DocumentConfigurationError();await deps.objects.putPart(identity(ctx,captured.row),input.index,captured.parts,bytes,captured.ttl);}
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentRepository(tx,ctx.organizationId),row=await repository.admission(input.admissionId);if(!row)throw new DocumentAccessError();
    const current=await admittedContext(ctx,tx,row);if(current.superseded||current.fingerprint!==captured.fingerprint)throw new DocumentConflictError();
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.upload_part_saved",resourceType:"document",resourceId:row.documentId,
      after:{documentId:row.documentId,admissionId:row.id,index:input.index},requestId:deps.requestId??randomUUID(),occurredAt:current.now});
    const final=await admittedContext(ctx,tx,row);if(final.superseded||current.fingerprint!==final.fingerprint)throw new DocumentConflictError();
    return documentPartReceiptSchema.parse({admissionId:row.id,idempotencyKey:row.commandKey,index:input.index,sha256:captured.sha256});
  });
}

export async function completeDocumentParts(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=actorContext(actor),input=uploadReference.parse(raw),captured=await withTenant(deps.db,ctx.organizationId,async tx=>{
    const row=await new DocumentRepository(tx,ctx.organizationId).admission(input.admissionId);if(!row)throw new DocumentAccessError();
    const current=await admittedContext(ctx,tx,row),original=documentUploadInput.parse(row.input),parts=original.parts??null;
    if(current.superseded||!parts&&row.contentType!==documentTemplateMediaType)throw new DocumentConflictError();
    if(row.contentType===documentTemplateMediaType&&(!original.templateKey||!row.payloadCipher))throw new DocumentConflictError();
    const template=row.contentType===documentTemplateMediaType&&original.templateKey?{...identity(ctx,row),templateKey:original.templateKey,locale:original.locale}:null;
    const result=row.version?await admissionResult(ctx,tx,row):null;if(result)return{row,parts,template,ttl:current.policy.value.storage_url_seconds,result,decision:null};
    const budget=current.policy.value.upload_transport;if(!budget)throw new DocumentConfigurationError();
    const decision=await consumeRateLimit(tx,ctx.organizationId,{key:"document-parts:"+ctx.actorId,limit:budget.max_requests,windowSeconds:budget.window_seconds,now:current.now});
    return{row,parts,template,ttl:current.policy.value.storage_url_seconds,result:null,decision};
  });
  if(captured.result)return captured.result;if(captured.decision&&!captured.decision.allowed)throw new DocumentRateLimitError(captured.decision.resetAt);
  if(captured.template&&captured.row.payloadCipher)return uploadDocumentBytes(ctx,input,openDocumentTemplatePayload(captured.template,captured.row.payloadCipher,deps.env),deps);
  const parts=captured.parts;if(!parts)throw new DocumentConflictError();
  if(!deps.objects)throw new DocumentConfigurationError();const objects=deps.objects,chunks:Buffer[]=[];
  for(let offset=0;offset<parts.hashes.length;offset+=4){const indices=Array.from({length:Math.min(4,parts.hashes.length-offset)},(_,index)=>offset+index);
    chunks.push(...await Promise.all(indices.map(index=>objects.readPart(identity(ctx,captured.row),index,parts,captured.ttl))));}
  return uploadDocumentBytes(ctx,input,Buffer.concat(chunks),deps);
}

const historyInput = z.object({ documentId: z.uuid(), before: z.number().int().positive().optional() }).strict();
export async function readDocumentHistory(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = actorContext(actor), input = historyInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), root = await repository.document(input.documentId); if (!root) throw new DocumentAccessError();
    const current = await context(ctx, tx, sourceOf(root), "view", root), rows = await repository.versions(root.id, input.before), data = { id: root.id, source: sourceOf(root), typeKey: root.typeKey, kind: root.kind, locale: root.locale,
      title: root.title, privacy: current.privacy, revision: root.revision.toString(), createdAt: root.createdAt.toISOString(), archivedAt: root.archivedAt?.toISOString() ?? null, templateKey: root.template?.key ?? null };
    const document = documentItemSchema.parse(present({ ...ctx.authContext, visibleDataClasses: new Set<DataClass>(current.privacy) }, "view",
      { ...current.native.resource, type: "document", id: root.id, documentId: root.id, assignedUserAccountId: root.createdBy, data }, {}, current.now));
    const result = documentHistorySchema.parse({ document, versions: rows.slice(0,50).map(row => publicVersion(ctx, current, root, row)), next: rows.length>50 ? rows[49].number : null });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.history_read", resourceType: "document", resourceId: root.id,
      after: { documentId: root.id, count: result.versions.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
    const finalRoot = await repository.document(root.id); if (!finalRoot) throw new DocumentAccessError();
    const final = await context(ctx, tx, sourceOf(finalRoot), "view", finalRoot); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError(); return result;
  });
}

export async function downloadDocumentVersion(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = actorContext(actor), input = z.object({ versionId: z.uuid() }).strict().parse(raw);
  const captured = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), row = await repository.version(input.versionId); if (!row) throw new DocumentAccessError();
    const root = await repository.document(row.documentId); if (!root) throw new DocumentAccessError();
    const current = await context(ctx, tx, sourceOf(root), "export", root); return { row, root, fingerprint: current.fingerprint, ttl: current.policy.value.storage_url_seconds };
  });
  if (!deps.objects) throw new DocumentConfigurationError();
  const bytes = await deps.objects.read(identity(ctx, captured.row.admission), captured.row, captured.ttl);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), root = await repository.document(captured.root.id); if (!root) throw new DocumentAccessError();
    const current = await context(ctx, tx, sourceOf(root), "export", root); if (current.fingerprint !== captured.fingerprint) throw new DocumentConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.version_downloaded", resourceType: "document", resourceId: root.id,
      after: { documentId: root.id, versionId: captured.row.id }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
    const finalRoot = await repository.document(root.id); if (!finalRoot) throw new DocumentAccessError();
    const final = await context(ctx, tx, sourceOf(finalRoot), "export", finalRoot); if (final.fingerprint !== captured.fingerprint) throw new DocumentConflictError();
    return { bytes, fileName: captured.row.admission.fileName, contentType: captured.row.admission.contentType };
  });
}

/** Generation reads the same authenticated original retained before object I/O, after complete archive/source export authorization. */
export async function readDocumentTemplateDefinition(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = actorContext(actor), input = z.object({ versionId: z.uuid() }).strict().parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), row = await repository.version(input.versionId);
    if (!row) throw new DocumentAccessError();
    const root = await repository.document(row.documentId); if (!root || root.kind !== "TEMPLATE" || !root.template) throw new DocumentAccessError();
    const current = await context(ctx, tx, sourceOf(root), "export", root);
    if (root.archivedAt || current.native.archived || row.admission.contentType !== documentTemplateMediaType || !row.admission.payloadCipher) throw new DocumentConflictError();
    const locale = z.enum(["en", "fr", "ar"]).parse(root.locale), bytes = openDocumentTemplatePayload({ ...identity(ctx, row.admission), templateKey: root.template.key, locale }, row.admission.payloadCipher, deps.env), definition = decodeDocumentTemplate(bytes);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.template_read_for_generation", resourceType: "document", resourceId: root.id,
      after: { documentId: root.id, versionId: row.id }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
    const latest = await repository.document(root.id); if (!latest) throw new DocumentAccessError();
    const final = await context(ctx, tx, sourceOf(latest), "export", latest); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return { definition, versionId: row.id, documentId: root.id, sha256: row.admission.sha256, typeKey: root.typeKey, templateKey: root.template.key, locale,
      rootRevision: root.revision.toString(), sourceFingerprint: current.native.fingerprint, policyFingerprint: commandFingerprint(current.policy), privacy: current.privacy, fingerprint: current.fingerprint };
  });
}
