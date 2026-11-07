import { randomUUID } from "node:crypto";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { nativeSignatureHistoryInput, nativeSignatureHistorySchema, nativeSignatureListInput, nativeSignatureListSchema, nativeSignatureHistoryStates } from "../domain/document-signature-history";
import { nativeSignatureRecipientPayloadSchema } from "../domain/document-signature-command";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";
import { DocumentRepository } from "../infrastructure/document-repository";
import { openNativeSignatureRecipient } from "../infrastructure/document-signature-recipient-payload";
import { documentActorContext, type DocumentActorContext } from "./document-archive";
import { nativeSignatureContext, nativeSignatureOriginalDefinition, assertSignatureOriginalArchive, presentNativeSignatureParty } from "./document-signature-draft";
import { documentReadCursor, readDocumentCursor } from "./document-workspace";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { originalSignaturePreparation, readSignaturePreparationEvidence } from "./document-signature-preparation";

type Dependencies = { db: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string };
/** History authorizes the actual retained resources; current business values cannot replace original contacts. */
async function retainedContext(ctx: DocumentActorContext, tx: TenantTransaction, signatureId: string, deps: Pick<Dependencies, "env">) {
  const repository = new DocumentRepository(tx, ctx.organizationId), row = await repository.signatureRecord(signatureId); if (!row) throw new DocumentAccessError();
  const original = nativeSignatureOriginalDefinition(row), current = await nativeSignatureContext(ctx, tx, original.draft, "history", row.id, row.requestedBy); assertSignatureOriginalArchive(current, original.snapshot);
  const recipients = row.recipients.map(recipient => {
    const retained = nativeSignatureRecipientPayloadSchema.omit({ displayName: true, email: true }).parse(recipient.sourceSnapshot), descriptor = original.snapshot.recipients.find(item => item.identityHash === recipient.identityHash),
      party = current.parties.find(item => commandFingerprint(item.reference) === recipient.identityHash), identity = retained.identity;
    if (!descriptor || !party || identity.organizationId !== ctx.organizationId || identity.signatureId !== row.id || identity.recipientId !== recipient.id || identity.fingerprint !== descriptor.fingerprint ||
      commandFingerprint(identity.reference) !== recipient.identityHash || commandFingerprint(descriptor.reference) !== recipient.identityHash) throw new DocumentConflictError();
    const contact = openNativeSignatureRecipient(identity, recipient.emailCipher, deps.env), visible = presentNativeSignatureParty(ctx, current, party, { displayName: contact.displayName, email: contact.email });
    return { id: recipient.id, reference: identity.reference, ...visible };
  });
  if (recipients.length !== original.snapshot.recipients.length) throw new DocumentConflictError();
  return { repository, row, current, recipients, fingerprint: current.fingerprint };
}
export { retainedContext as retainedNativeSignatureReadContext };
async function summary(current: Awaited<ReturnType<typeof retainedContext>>) {
  const latest = await current.repository.latestSignatureEvent(current.row.id); if (!latest) throw new DocumentConflictError();
  return { id: current.row.id, documentId: current.current.instance.documentId, instanceId: current.row.instanceId, documentVersionId: current.row.documentVersionId, requestedAt: current.row.requestedAt.toISOString(), state: nativeSignatureHistoryStates.parse(latest.state) };
}
export async function listNativeSignatures(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = nativeSignatureListInput.parse(raw), filter = commandFingerprint({ operation: "NATIVE_SIGNATURE_LIST", documentVersionId: input.documentVersionId }), before = readDocumentCursor(ctx, filter, input.cursor);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new DocumentRepository(tx, ctx.organizationId), version = await repository.version(input.documentVersionId), generated = generatedDocumentUploadInput.safeParse(version?.admission.input); if (!generated.success || !generated.data.generationInstanceId) throw new DocumentAccessError();
    const draft = { instanceId: generated.data.generationInstanceId, documentVersionId: input.documentVersionId, recipients: [] }, base = await nativeSignatureContext(ctx, tx, draft, "history"), rows = await repository.signaturesForVersion(input.documentVersionId, before), selected = [];
    for (const row of rows.slice(0, 30)) { try { selected.push(await retainedContext(ctx, tx, row.id, deps)); } catch (error) { if (!(error instanceof DocumentAccessError)) throw error; } }
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.history_listed", resourceType: "document", resourceId: base.instance.documentId,
      after: { documentId: base.instance.documentId, versionId: input.documentVersionId, count: selected.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: base.archive.now });
    if ((await nativeSignatureContext(ctx, tx, draft, "history")).fingerprint !== base.fingerprint) throw new DocumentConflictError();
    const items = []; for (const retained of selected) { const final = await retainedContext(ctx, tx, retained.row.id, deps); if (final.fingerprint !== retained.fingerprint) throw new DocumentConflictError(); items.push(await summary(final)); }
    return nativeSignatureListSchema.parse({ documentVersionId: input.documentVersionId, items, next: rows.length > 30 ? documentReadCursor(ctx, filter, rows[29].id) : null });
  });
}
export async function readNativeSignatureHistory(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = nativeSignatureHistoryInput.parse(raw), filter = commandFingerprint({ operation: "NATIVE_SIGNATURE_HISTORY", signatureId: input.signatureId }), before = readDocumentCursor(ctx, filter, input.cursor);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await retainedContext(ctx, tx, input.signatureId, deps), rows = await current.repository.signatureEvents(current.row.id, before); if (!rows) throw new DocumentAccessError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.history_read", resourceType: "signature", resourceId: current.row.id,
      after: { signatureId: current.row.id, versionId: current.row.documentVersionId, count: Math.min(rows.length, 50) }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.current.archive.now });
    const providerRepository = new SignaturePreparationRepository(tx, ctx.organizationId), attempt = await providerRepository.preparationAttempt(current.row.id); let preparation = null;
    if (attempt) { const intent = await providerRepository.preparation(attempt.intentId); if (!intent || intent.signatureId !== current.row.id) throw new DocumentConflictError(); const original = originalSignaturePreparation(intent), evidence = attempt.evidence.find(row => row.kind === "PREPARED");
      if (original.snapshot.signatureCommandHash !== current.row.commandHash) throw new DocumentConflictError(); if (evidence && readSignaturePreparationEvidence(intent, evidence, deps.env).kind !== "PREPARED") throw new DocumentConflictError(); preparation = { id: intent.id, state: evidence ? "PREPARED" as const : "UNCERTAIN" as const }; }
    const final = await retainedContext(ctx, tx, input.signatureId, deps); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return nativeSignatureHistorySchema.parse({ signature: await summary(final), document: { title: final.current.version.title, locale: final.current.instance.document.locale, sha256: final.current.version.admission.sha256 }, preparation, recipients: final.recipients,
      events: rows.slice(0, 50).map(row => ({ id: row.id, state: row.state, occurredAt: row.occurredAt.toISOString(), observedAt: row.observedAt.toISOString(), signedVersionId: row.signedVersionId })), next: rows.length > 50 ? documentReadCursor(ctx, filter, rows[49].id) : null });
  });
}
