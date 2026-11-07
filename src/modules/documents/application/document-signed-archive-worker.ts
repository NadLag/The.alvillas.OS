import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import type { SignatureProvider } from "@/platform/providers";
import { DocumentAccessError, DocumentConflictError, DocumentConfigurationError } from "../domain/document-command";
import { signedArchiveRequested } from "../domain/document-signed-archive";
import { SignedSignatureRepository } from "../infrastructure/signed-signature-repository";
import type { DocumentObjectStore } from "../infrastructure/document-object-store";
import { readCompletedSignaturePackage } from "../infrastructure/signed-signature-package";
import { configuredDocumentObjects } from "./document-files";
import { originalSignedArchive, signedArchiveOutboxKey } from "./document-signed-archive-admission";
import { retainedSignatureProviderContract } from "./document-signature-retained-contract";
import { captureSignedArchiveArtifacts, retainedSignedArtifact, signedCaptureEvidence, appendSignedArchiveHistory } from "./document-signed-archive-publication";
import { appendNativeSignatureProviderEvidence, readNativeSignatureProviderEvidence } from "./document-signature-provider-evidence";
import { originalSignedReconciliation, signedReconciliationOutboxKey } from "./document-signed-archive-reconciliation";

const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ archiveId: z.uuid(), reconciliationId: z.uuid().optional() }).strict();
type Reference = z.infer<typeof referenceSchema>;
type Dependencies = { db?: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string; objects?: DocumentObjectStore; provider?: Pick<SignatureProvider, "readSignatureRequest" | "downloadSignatureRequest" | "downloadSignatureCertificate">; providerOrigin?: string };
async function referenced(tx: TenantTransaction, reference: Reference, env?: NodeJS.ProcessEnv) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload), repository = new SignedSignatureRepository(tx, reference.organizationId), archive = payload.success ? await repository.signedArchive(payload.data.archiveId) : null;
  if (!event || event.type !== signedArchiveRequested || !archive || !payload.success) throw new DocumentAccessError();
  if (payload.data.reconciliationId) { const command = await repository.signedReconciliation(payload.data.reconciliationId); if (!command?.actorId) throw new DocumentAccessError(); const { snapshot } = originalSignedReconciliation(command); if (snapshot.archiveId !== archive.id || snapshot.input.signatureId !== archive.signatureId || event.idempotencyKey !== signedReconciliationOutboxKey(command.actorId, command.commandKey) || event.occurredAt.getTime() !== command.occurredAt.getTime()) throw new DocumentAccessError(); }
  else if (event.idempotencyKey !== signedArchiveOutboxKey(archive.id) || event.occurredAt.getTime() !== archive.admittedAt.getTime()) throw new DocumentAccessError();
  const snapshot = originalSignedArchive(archive), original = await retainedSignatureProviderContract(tx, reference.organizationId, snapshot.preparation.intentId, env), attempt = await repository.preparationAttempt(archive.signatureId), completion = attempt?.evidence.find(row => row.id === archive.completionEvidenceId);
  if (!attempt || attempt.id !== archive.preparationAttemptId || !completion || completion.kind !== "COMPLETION" || completion.payloadSha256 !== snapshot.completion.payloadSha256 || completion.providerRequestId !== archive.providerRequestId || completion.providerScopeHash !== archive.providerScopeHash || original.original.snapshot.contractHash !== snapshot.contractHash || original.signature.commandHash !== snapshot.signatureCommandHash || original.signature.documentVersionId !== snapshot.document.versionId) throw new DocumentConflictError();
  if (readNativeSignatureProviderEvidence(original.intent, completion, original.original.snapshot, env).kind !== "COMPLETION") throw new DocumentConflictError();
  const signed = archive.evidence.find(row => row.kind === "SIGNED"); if (signed && readNativeSignatureProviderEvidence(original.intent, signed, original.original.snapshot, env).kind !== "SIGNED") throw new DocumentConflictError(); return { repository, archive, snapshot, original, attempt, signed };
}
const summary = (archiveId: string) => ({ archiveId, state: "COMPLETE" as const });
/** Every external operation is a GET or conditional private-object PUT; no signing POST is available. */
export async function executeSignedArchiveReference(raw: unknown, deps: Dependencies = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, initial = await withTenant(db, reference.organizationId, tx => referenced(tx, reference, deps.env)); if (initial.signed) return summary(initial.archive.id);
  try {
    if (!initial.archive.evidence.some(row => row.kind === "ARCHIVE_CAPTURED")) {
      const type = initial.snapshot.archivePolicy.value.types.find(type => type.key === initial.snapshot.typeKey && type.sources.includes(initial.snapshot.document.source.kind) && type.content_types.includes("application/pdf")); if (!type) throw new DocumentConfigurationError();
      const pkg = await readCompletedSignaturePackage(initial.original.policy.account, initial.original.metadata, initial.archive.providerRequestId, type.max_bytes, deps);
      await withTenant(db, reference.organizationId, async tx => { const current = await referenced(tx, reference, deps.env); if (current.archive.commandHash !== initial.archive.commandHash) throw new DocumentConflictError(); await captureSignedArchiveArtifacts(tx, current.repository, current.archive, pkg, deps); });
    }
    const chosen = await withTenant(db, reference.organizationId, async tx => { const current = await referenced(tx, reference, deps.env), capture = await signedCaptureEvidence(tx, current.repository, current.archive, deps.env); return { current, capture, files: current.archive.artifacts.map(artifact => ({ artifact, ...retainedSignedArtifact(current.archive, artifact, deps.env) })) }; }), objects = deps.objects ?? configuredDocumentObjects(), manifests: { artifactId: string; manifest: Awaited<ReturnType<DocumentObjectStore["put"]>> }[] = [];
    for (const file of chosen.files) { const manifest = await objects.put(file.snapshot.identity, file.bytes, chosen.current.snapshot.archivePolicy.value.storage_url_seconds); manifests.push({ artifactId: file.artifact.id, manifest }); }
    return withTenant(db, reference.organizationId, async tx => {
      const current = await referenced(tx, reference, deps.env); await current.repository.lock("signature-provider:" + current.archive.signatureId); const fresh = await referenced(tx, reference, deps.env); if (fresh.signed) return summary(fresh.archive.id); const capture = await signedCaptureEvidence(tx, fresh.repository, fresh.archive, deps.env); if (capture.evidence.id !== chosen.capture.evidence.id || fresh.archive.commandHash !== chosen.current.archive.commandHash) throw new DocumentConflictError();
      const now = await fresh.repository.clock(), versions = [];
      for (const artifact of fresh.archive.artifacts) {
        const recorded = manifests.find(row => row.artifactId === artifact.id); if (!recorded) throw new DocumentConflictError(); const original = retainedSignedArtifact(fresh.archive, artifact, deps.env); let version = artifact.admission.version;
        if (!version) {
          version = await fresh.repository.appendVersion({ documentId: artifact.documentId, admissionId: artifact.admissionId, number: 1, title: fresh.snapshot.title, supersedesId: null, effectiveFrom: null, cipherSize: recorded.manifest.cipherSize, cipherSha256: recorded.manifest.cipherSha256, keyVersion: recorded.manifest.keyVersion, createdBy: fresh.snapshot.initiatedBy, createdAt: now });
          await appendSignedArchiveHistory(tx, fresh.repository, fresh.archive, artifact, "VERSION_ADDED", artifact.id, original.snapshot.commandHash, original.snapshot.sourceFingerprint, now, deps, version.id);
        }
        versions.push({ artifact, version });
      }
      const signed = versions.find(row => row.artifact.kind === "SIGNED_ORIGINAL"), certificate = versions.find(row => row.artifact.kind === "CERTIFICATE"); if (!signed || !certificate) throw new DocumentConflictError();
      await appendNativeSignatureProviderEvidence(tx, fresh.repository, fresh.original.intent, fresh.attempt, fresh.original.original.snapshot, { kind: "SIGNED", providerRequestId: fresh.archive.providerRequestId, observation: capture.value.observation, observationReceipt: capture.value.observationReceipt, prepareReceipt: null, scopeProof: capture.value.scopeProof, failureCode: null,
        signedArchive: { ...capture.proof, captureEvidenceId: capture.evidence.id, signedVersionId: signed.version.id, certificateVersionId: certificate.version.id } }, deps);
      await new OutboxRepository(tx, reference.organizationId).append("documents.signature.signed_archived", { archiveId: fresh.archive.id }, "document-signed-archive-completed:" + fresh.archive.id, now); return summary(fresh.archive.id);
    });
  } catch {
    await withTenant(db, reference.organizationId, async tx => { const current = await referenced(tx, reference, deps.env); await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "documents.signature.signed_archive_blocked", resourceType: "signature", resourceId: current.archive.id, after: { signatureId: current.archive.signatureId, signedArchiveId: current.archive.id, failureCode: "SIGNED_ARCHIVE_UNCONFIRMED" }, requestId: deps.requestId ?? randomUUID(), occurredAt: await current.repository.clock() }); });
    throw new DocumentConflictError();
  }
}
