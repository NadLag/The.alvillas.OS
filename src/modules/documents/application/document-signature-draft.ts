import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { catalogFieldPolicy, present } from "@/platform/authz/present";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { DocumentRepository } from "../infrastructure/document-repository";
import { sealNativeSignatureRecipient } from "../infrastructure/document-signature-recipient-payload";
import { documentActorContext, documentArchiveContext, appendDocumentHistory, documentJson, type DocumentActorContext } from "./document-archive";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError, DocumentRateLimitError, documentRecoveryInput, documentSourceReferenceSchema } from "../domain/document-command";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";
import { nativeSignatureCommandSchema, nativeSignatureDraftSchema, nativeSignatureSnapshotSchema, nativeSignatureReceiptSchema, nativeSignatureRecipientProtocol, nativeSignatureProtocol, nativeSignatureDraftCreated } from "../domain/document-signature-command";
import { nativeSignatureChoicesInput, nativeSignatureChoicesSchema } from "../domain/document-signature-command";
import { documentReadCursor, readDocumentCursor } from "./document-workspace";

type Dependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string };
type Draft = z.infer<typeof nativeSignatureDraftSchema>;
type Signature = NonNullable<Awaited<ReturnType<DocumentRepository["signature"]>>>;
const normalized = (draft: Draft): Draft => ({ ...draft, recipients: [...draft.recipients].sort((left, right) => (left.kind + ":" + left.id).localeCompare(right.kind + ":" + right.id)) });
export const signatureDraftOutboxKey = (actorId: string, nonce: string) => "document-signature-draft:" + actorId + ":" + nonce;

/** All source, template-origin, signature and actual counterparty grants remain independent. */
export async function nativeSignatureContext(ctx: DocumentActorContext, tx: TenantTransaction, draft: Draft, action: "view" | "create" | "history", signatureId?: string, requestedBy = ctx.actorId) {
  const repository = new DocumentRepository(tx, ctx.organizationId), instance = await repository.instance(draft.instanceId), version = await repository.version(draft.documentVersionId);
  if (!instance || !version || version.documentId !== instance.documentId || version.admission.contentType !== "application/pdf" || !(await repository.versionMatchesInstance(version.id, instance.id))) throw new DocumentAccessError();
  const input = generatedDocumentUploadInput.safeParse(version.admission.input); if (!input.success || input.data.generationInstanceId !== instance.id) throw new DocumentAccessError();
  const source = documentSourceReferenceSchema.parse({ kind: instance.document.sourceKind, id: instance.document.sourceId }), archive = await documentArchiveContext(ctx, tx, source, "export", instance.document);
  // Lead signing requires the native recipient producer introduced by F-CRM-06.
  if(source.kind==="LEAD")throw new DocumentConfigurationError();
  const parties = await Promise.all(draft.recipients.map(reference => repository.signatureRecipientSource(reference)));
  if (action === "create" && (instance.document.archivedAt || archive.native.archived)) throw new DocumentAccessError();
  if (parties.some(party => !party || action !== "history" && party.archived)) throw new DocumentAccessError();
  const actual = parties.map(party => { if (!party) throw new DocumentAccessError(); return party; }), checks: CurrentAuthorityCheck[] = actual.flatMap(party => party.checks);
  for (const dataClass of archive.privacy) {
    const resource = { ...archive.native.resource, type: "signature", id: signatureId, documentId: instance.documentId, assignedUserAccountId: requestedBy, dataClass };
    checks.push({ action: "view", resource }, ...action === "create" ? [{ action: "create" as const, resource }] : []);
  }
  await recheckAccountAuthorization(ctx, tx, await repository.clock(), checks, new DocumentAccessError());
  return { repository, instance, version, source, archive, parties: actual, checks,
    fingerprint: commandFingerprint({ archive: archive.fingerprint, instanceId: instance.id, versionId: version.id, sha256: version.admission.sha256, byteSize: version.admission.fileSize, parties: actual.map(party => ({ reference: party.reference, fingerprint: party.fingerprint })) }) };
}
type Context = Awaited<ReturnType<typeof nativeSignatureContext>>;
function partyPresentation(ctx: DocumentActorContext, current: Context) {
  return current.parties.map(party => {
    const value = presentNativeSignatureParty(ctx, current, party, { displayName: party.displayName, email: party.email });
    return { reference: party.reference, ...value, fingerprint: party.fingerprint, identityHash: commandFingerprint(party.reference) };
  });
}
export function presentNativeSignatureParty(ctx: DocumentActorContext, current: Context, party: Context["parties"][number], data: { displayName: string | null; email: string | null }) {
  const visible = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "export", { ...party.resource, data }, catalogFieldPolicy<typeof data>(party.resource.type), current.archive.now);
  if (visible.displayName !== data.displayName || visible.email !== data.email) throw new DocumentAccessError();
  const value = z.object({ displayName: z.string().min(1).max(500), email: z.email().max(254) }).safeParse(visible); if (!value.success) throw new DocumentConfigurationError(); return value.data;
}
export { partyPresentation as presentSignatureParties };
function reviewFingerprint(ctx: DocumentActorContext, draft: Draft, current: Context) { return commandFingerprint({ actorId: ctx.actorId, draft, source: current.fingerprint, cap: captureAuthorizationCap(ctx.authContext) }); }
export async function readNativeSignatureChoices(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = nativeSignatureChoicesInput.parse(raw), filter = commandFingerprint({ operation: "SIGNATURE_PARTIES", documentVersionId: input.documentVersionId, kind: input.kind, query: input.query }), before = readDocumentCursor(ctx, filter, input.cursor);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), version = await repository.version(input.documentVersionId), generated = generatedDocumentUploadInput.safeParse(version?.admission.input);
    if (!generated.success || !generated.data.generationInstanceId) throw new DocumentAccessError();
    const target = { instanceId: generated.data.generationInstanceId, documentVersionId: input.documentVersionId, recipients: [] }, current = await nativeSignatureContext(ctx, tx, target, "view"),
      rows = await repository.signatureRecipientCandidates(input.kind, input.query, before), selected: Context[] = [];
    for (const row of rows.slice(0, 30)) {
      try { const candidate = await nativeSignatureContext(ctx, tx, { ...target, recipients: [{ kind: input.kind, id: row.id }] }, "view"); partyPresentation(ctx, candidate); selected.push(candidate); }
      catch (error) { if (!(error instanceof DocumentAccessError || error instanceof DocumentConfigurationError)) throw error; }
    }
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature_recipients_read", resourceType: "document", resourceId: current.instance.documentId,
      after: { documentId: current.instance.documentId, versionId: input.documentVersionId, recipientCount: selected.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.archive.now });
    const final = await nativeSignatureContext(ctx, tx, target, "view"); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    const items = [];
    for (const candidate of selected) {
      const retained = await nativeSignatureContext(ctx, tx, { ...target, recipients: candidate.parties.map(party => party.reference) }, "view");
      if (retained.fingerprint !== candidate.fingerprint) throw new DocumentConflictError(); items.push(...partyPresentation(ctx, retained));
    }
    await recheckAccountAuthorization(ctx, tx, await repository.clock(), [...final.archive.checks, ...selected.flatMap(candidate => candidate.checks)], new DocumentAccessError());
    return nativeSignatureChoicesSchema.parse({ instanceId: target.instanceId, documentVersionId: input.documentVersionId, items, next: rows.length > 30 ? documentReadCursor(ctx, filter, rows[29].id) : null });
  });
}
export async function reviewNativeSignature(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), draft = normalized(nativeSignatureDraftSchema.parse(raw));
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await nativeSignatureContext(ctx, tx, draft, "view"); partyPresentation(ctx, current);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature_reviewed", resourceType: "document", resourceId: current.instance.documentId,
      after: { documentId: current.instance.documentId, instanceId: current.instance.id, versionId: current.version.id, recipientCount: draft.recipients.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.archive.now });
    const final = await nativeSignatureContext(ctx, tx, draft, "view"); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return { reviewFingerprint: reviewFingerprint(ctx, draft, final), document: { id: final.instance.documentId, instanceId: final.instance.id, versionId: final.version.id, title: final.version.title, sha256: final.version.admission.sha256, locale: final.instance.document.locale },
      recipients: partyPresentation(ctx, final), privacy: final.archive.privacy };
  });
}
export function nativeSignatureOriginalDefinition(row: Omit<Signature, "events">) {
  const snapshot = nativeSignatureSnapshotSchema.parse(row.policySnapshot), command = snapshot.command, cap = restoreAuthorizationCap(row.authorizationCap),
    draft = normalized(nativeSignatureDraftSchema.parse({ instanceId: command.instanceId, documentVersionId: command.documentVersionId, recipients: command.recipients }));
  if (snapshot.commandHash !== row.commandHash || commandFingerprint(command) !== row.commandHash || snapshot.nativeSourceFingerprint !== row.sourceFingerprint || snapshot.document.instanceId !== row.instanceId || snapshot.document.versionId !== row.documentVersionId || command.idempotencyKey !== row.commandKey) throw new DocumentConflictError();
  if (cap.organizationId !== row.organizationId || cap.userAccountId !== row.requestedBy || command.reason !== row.reason) throw new DocumentConflictError();
  return { snapshot, command, draft, cap };
}
export function assertSignatureOriginalArchive(current: Context, snapshot: z.infer<typeof nativeSignatureSnapshotSchema>) {
  if (snapshot.document.id !== current.instance.documentId || snapshot.document.admissionId !== current.version.admission.id || snapshot.document.sha256 !== current.version.admission.sha256 ||
    snapshot.document.byteSize !== current.version.admission.fileSize || snapshot.document.locale !== current.instance.document.locale || commandFingerprint(snapshot.document.source) !== commandFingerprint(current.source)) throw new DocumentConflictError();
}
export function signatureNativeInputsChanged(current: Context, snapshot: z.infer<typeof nativeSignatureSnapshotSchema>) {
  return current.archive.fingerprint !== snapshot.archiveFingerprint || current.archive.native.fingerprint !== snapshot.nativeSourceFingerprint || current.parties.some((party, index) => party.fingerprint !== snapshot.recipients[index]?.fingerprint);
}
async function signatureResult(ctx: DocumentActorContext, tx: TenantTransaction, row: Signature) {
  if (row.requestedBy !== ctx.actorId) throw new DocumentAccessError(); const { snapshot, draft, cap } = nativeSignatureOriginalDefinition(row), original = documentActorContext({ ...ctx, authContext: cap });
  const current = await nativeSignatureContext(ctx, tx, draft, "create", row.id), held = await nativeSignatureContext(original, tx, draft, "create", row.id);
  assertSignatureOriginalArchive(current, snapshot);
  if (current.fingerprint !== held.fingerprint) throw new DocumentConflictError();
  const changed = signatureNativeInputsChanged(current, snapshot);
  return nativeSignatureReceiptSchema.parse({ recorded: true, id: row.id, idempotencyKey: row.commandKey, documentId: current.instance.documentId, instanceId: row.instanceId, documentVersionId: row.documentVersionId, state: changed ? "SOURCE_CHANGED" : "DRAFT" });
}
export async function admitNativeSignature(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), parsed = nativeSignatureCommandSchema.parse(raw), draft = normalized({ instanceId: parsed.instanceId, documentVersionId: parsed.documentVersionId, recipients: parsed.recipients }),
    command = { ...parsed, recipients: draft.recipients }, commandHash = commandFingerprint(command);
  const replay = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.signatureByNonce(ctx.actorId, command.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return signatureResult(ctx, tx, existing); }
    if (await repository.byNonce(ctx.actorId, command.idempotencyKey) || await repository.instanceByNonce(ctx.actorId, command.idempotencyKey) || await repository.providerPreparationByNonce(ctx.actorId, command.idempotencyKey)) throw new DocumentConflictError(); return null;
  }); if (replay) return replay;
  const rate = await withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await nativeSignatureContext(ctx, tx, draft, "create"); partyPresentation(ctx, current); if (reviewFingerprint(ctx, draft, current) !== command.reviewFingerprint) throw new DocumentConflictError();
    const budget = current.archive.policy.value.upload_admission; return consumeRateLimit(tx, ctx.organizationId, { key: "document-signature:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.archive.now });
  }); if (!rate.allowed) throw new DocumentRateLimitError(rate.resetAt);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + command.idempotencyKey);
    const existing = await repository.signatureByNonce(ctx.actorId, command.idempotencyKey); if (existing) { if (existing.commandHash !== commandHash) throw new DocumentConflictError(); return signatureResult(ctx, tx, existing); }
    if (await repository.byNonce(ctx.actorId, command.idempotencyKey) || await repository.instanceByNonce(ctx.actorId, command.idempotencyKey) || await repository.providerPreparationByNonce(ctx.actorId, command.idempotencyKey)) throw new DocumentConflictError();
    const id = randomUUID(); let current = await nativeSignatureContext(ctx, tx, draft, "create", id); await repository.lock("root:" + current.instance.documentId); current = await nativeSignatureContext(ctx, tx, draft, "create", id);
    const parties = partyPresentation(ctx, current); if (reviewFingerprint(ctx, draft, current) !== command.reviewFingerprint) throw new DocumentConflictError();
    const snapshot = nativeSignatureSnapshotSchema.parse({ protocol: nativeSignatureProtocol, schemaVersion: 1, command, commandHash, archiveFingerprint: current.archive.fingerprint, nativeSourceFingerprint: current.archive.native.fingerprint, archivePolicy: current.archive.policy,
      document: { id: current.instance.documentId, instanceId: current.instance.id, versionId: current.version.id, admissionId: current.version.admission.id, sha256: current.version.admission.sha256, byteSize: current.version.admission.fileSize, locale: current.instance.document.locale, source: current.source },
      recipients: parties.map(({ reference, identityHash, fingerprint }) => ({ reference, identityHash, fingerprint })) });
    await repository.appendSignature({ id, instanceId: current.instance.id, documentVersionId: current.version.id, policySnapshot: documentJson(snapshot), authorizationCap: documentJson(captureAuthorizationCap(ctx.authContext)),
      sourceFingerprint: current.archive.native.fingerprint, commandKey: command.idempotencyKey, commandHash, reason: command.reason, requestedBy: ctx.actorId, requestedAt: current.archive.now });
    for (const party of parties) {
      const recipientId = randomUUID(), identity = { organizationId: ctx.organizationId, signatureId: id, recipientId, reference: party.reference, fingerprint: party.fingerprint }, cipher = sealNativeSignatureRecipient({ protocol: nativeSignatureRecipientProtocol, schemaVersion: 1, identity, displayName: party.displayName, email: party.email }, deps.env);
      await repository.appendSignatureRecipient({ id: recipientId, signatureId: id, identityHash: party.identityHash, personId: party.reference.kind === "PERSON" ? party.reference.id : null, ownerId: party.reference.kind === "OWNER" ? party.reference.id : null,
        guestId: party.reference.kind === "GUEST" ? party.reference.id : null, supplierId: party.reference.kind === "SUPPLIER" ? party.reference.id : null, emailCipher: new Uint8Array(cipher), sourceSnapshot: documentJson({ protocol: nativeSignatureRecipientProtocol, schemaVersion: 1, identity }), createdAt: current.archive.now });
    }
    await repository.appendSignatureEvent({ signatureId: id, state: "DRAFT", evidenceHash: commandHash, occurredAt: current.archive.now, observedAt: current.archive.now });
    await appendDocumentHistory(ctx, tx, current.archive, current.instance.documentId, "SIGNATURE_CREATED", command.idempotencyKey, commandHash, command.reason, {}, { signatureId: id, instanceId: current.instance.id, versionId: current.version.id, recipientCount: parties.length }, deps);
    await new OutboxRepository(tx, ctx.organizationId).append(nativeSignatureDraftCreated, { signatureId: id }, signatureDraftOutboxKey(ctx.actorId, command.idempotencyKey), current.archive.now);
    const final = await nativeSignatureContext(ctx, tx, draft, "create", id); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError(); const row = await repository.signature(id); if (!row) throw new DocumentConflictError(); return signatureResult(ctx, tx, row);
  });
}
export async function recoverNativeSignature(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = documentRecoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId); await repository.lock("nonce:" + ctx.actorId + ":" + input.idempotencyKey); const existing = await repository.signatureByNonce(ctx.actorId, input.idempotencyKey); if (existing) return signatureResult(ctx, tx, existing);
    if (await repository.signatureNonceOwner(input.idempotencyKey) || await repository.nonceOwner(input.idempotencyKey) || await repository.instanceNonceOwner(input.idempotencyKey) || await repository.providerPreparationNonceOwner(input.idempotencyKey)) throw new DocumentAccessError();
    const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId); if ([current, ctx.authContext].some(cap => ["signature:view", "signature:create", "document:view"].some(key => !cap.permissions.has(key)))) throw new DocumentAccessError();
    return { recorded: false as const, id: null, idempotencyKey: input.idempotencyKey, state: null };
  });
}
