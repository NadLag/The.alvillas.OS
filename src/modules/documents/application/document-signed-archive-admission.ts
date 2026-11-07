import { randomUUID } from "node:crypto";
import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { DocumentConflictError } from "../domain/document-command";
import { retainDocumentPrivacy } from "../domain/document-policy";
import { signedArchiveProtocol, signedArchiveRequested, signedArchiveSnapshotSchema } from "../domain/document-signed-archive";
import type { SignedSignatureRepository } from "../infrastructure/signed-signature-repository";
import { nativeSignatureOriginalDefinition } from "./document-signature-draft";
import { retainedSignatureProviderContract } from "./document-signature-retained-contract";
import { readNativeSignatureProviderEvidence } from "./document-signature-provider-evidence";
import { documentJson } from "./document-archive";

type Completion = NonNullable<Awaited<ReturnType<SignedSignatureRepository["completionEvidence"]>>>;
export const signedArchiveOutboxKey = (id: string) => "document-signed-archive:" + id;
/** Only a genuine retained completion can admit an independent system archive. */
export async function admitOriginalSignedArchive(tx: TenantTransaction, repository: SignedSignatureRepository, completion: Completion, deps: { env?: NodeJS.ProcessEnv; requestId?: string }) {
  await repository.lock("signature-provider:" + completion.signatureId); const existing = await repository.signedArchiveForSignature(completion.signatureId); if (existing) return existing;
  const attempt = await repository.preparationAttempt(completion.signatureId); if (!attempt || attempt.id !== completion.attemptId || completion.kind !== "COMPLETION" || completion.phase !== "PREPARE") throw new DocumentConflictError();
  const original = await retainedSignatureProviderContract(tx, completion.organizationId, attempt.intentId, deps.env), observation = readNativeSignatureProviderEvidence(original.intent, completion, original.original.snapshot, deps.env), native = nativeSignatureOriginalDefinition(original.signature), root = await repository.document(original.version.documentId);
  if (!root || observation.kind !== "COMPLETION" || !observation.providerRequestId || observation.providerRequestId !== completion.providerRequestId || completion.providerScopeHash !== original.intent.providerScopeHash || !attempt.evidence.some(row => row.webhookId === null && row.providerRequestId === completion.providerRequestId)) throw new DocumentConflictError();
  const snapshot = signedArchiveSnapshotSchema.parse({ protocol: signedArchiveProtocol, schemaVersion: 1, signatureId: original.signature.id, signatureCommandHash: original.signature.commandHash, contractHash: original.original.snapshot.contractHash,
    preparation: { intentId: original.intent.id, attemptId: attempt.id, commandHash: original.intent.commandHash }, completion: { evidenceId: completion.id, payloadSha256: completion.payloadSha256 }, providerScopeHash: original.intent.providerScopeHash, providerRequestId: observation.providerRequestId,
    document: native.snapshot.document, title: original.version.title, typeKey: root.typeKey, privacy: retainDocumentPrivacy(root.privacy, ["sensitive"], native.snapshot.document.source.kind), archivePolicy: native.snapshot.archivePolicy, providerPolicy: original.original.snapshot.providerPolicy, initiatedBy: original.signature.requestedBy, originalAuthorizationCap: original.signature.authorizationCap, originalSourceFingerprint: original.signature.sourceFingerprint });
  const id = randomUUID(), canonicalRequest = JSON.stringify(snapshot), commandHash = commandFingerprint(snapshot), now = await repository.clock(), row = await repository.appendSignedArchive({ id, signatureId: original.signature.id, preparationAttemptId: attempt.id, completionEvidenceId: completion.id, providerScopeHash: original.intent.providerScopeHash, providerRequestId: observation.providerRequestId, canonicalRequest, commandHash, sourceSnapshot: documentJson(snapshot), admittedAt: now });
  await writeAuditEvent(tx, { organizationId: completion.organizationId, actorId: null, action: "documents.signature.signed_archive_requested", resourceType: "signature", resourceId: id, after: { signatureId: row.signatureId, signedArchiveId: id, completionEvidenceId: completion.id, commandHash }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
  await new OutboxRepository(tx, completion.organizationId).append(signedArchiveRequested, { archiveId: id }, signedArchiveOutboxKey(id), now); return row;
}
export function originalSignedArchive(row: NonNullable<Awaited<ReturnType<SignedSignatureRepository["signedArchive"]>>>) {
  const snapshot = signedArchiveSnapshotSchema.parse(row.sourceSnapshot); if (JSON.stringify(snapshot) !== row.canonicalRequest || commandFingerprint(snapshot) !== row.commandHash || snapshot.signatureId !== row.signatureId || snapshot.preparation.attemptId !== row.preparationAttemptId || snapshot.completion.evidenceId !== row.completionEvidenceId || snapshot.providerScopeHash !== row.providerScopeHash || snapshot.providerRequestId !== row.providerRequestId) throw new DocumentConflictError(); return snapshot;
}
