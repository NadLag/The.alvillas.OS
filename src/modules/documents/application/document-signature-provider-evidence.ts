import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { DocumentConflictError } from "../domain/document-command";
import { signatureProviderEvidenceProtocol, type signatureProviderEvidencePayloadSchema } from "../domain/document-signature-provider-evidence";
import { openSignatureProviderEvidence, sealSignatureProviderEvidence } from "../infrastructure/signature-provider-payload";
import type { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";

type Intent = NonNullable<Awaited<ReturnType<SignaturePreparationRepository["preparation"]>>>;
type Attempt = NonNullable<Awaited<ReturnType<SignaturePreparationRepository["preparationAttempt"]>>>;
export type SignatureProviderObservation = Omit<z.infer<typeof signatureProviderEvidencePayloadSchema>, "identity" | "protocol" | "schemaVersion">;
export function readNativeSignatureProviderEvidence(row: Intent, evidence: Attempt["evidence"][number], snapshot: { contractHash: string; document: { sha256: string } }, env?: NodeJS.ProcessEnv) {
  const value = openSignatureProviderEvidence({ organizationId: row.organizationId, signatureId: row.signatureId, intentId: row.id, attemptId: evidence.attemptId, evidenceId: evidence.id,
    commandHash: row.commandHash, providerScopeHash: row.providerScopeHash, contractHash: snapshot.contractHash, originalPdfSha256: snapshot.document.sha256,
    sha256: evidence.payloadSha256, byteSize: evidence.payloadByteSize }, evidence.payloadCipher, env);
  if ((value.webhook?.id ?? null) !== (evidence.webhookId ?? null) || (value.identityRecovery?.id ?? null) !== (evidence.identityRecoveryId ?? null) || (value.signedArchive?.id ?? null) !== (evidence.signedArchiveId ?? null)) throw new DocumentConflictError(); return value;
}
/** Append only a worker-verified fact tied to its original committed attempt. */
export async function appendNativeSignatureProviderEvidence(tx: TenantTransaction, repository: SignaturePreparationRepository, row: Intent, attempt: Attempt,
  snapshot: { contractHash: string; document: { sha256: string } }, value: SignatureProviderObservation, deps: { env?: NodeJS.ProcessEnv; requestId?: string }) {
  const observationHash = commandFingerprint(value), existing = await repository.preparationEvidence(attempt.id, observationHash); if (existing) return existing;
  if (value.kind !== "UNCERTAIN") { const confirmed = attempt.evidence.find(item => item.kind === value.kind && (item.webhookId ?? null) === (value.webhook?.id ?? null)); if (confirmed) return confirmed; }
  const id = randomUUID(), sealed = sealSignatureProviderEvidence({ protocol: signatureProviderEvidenceProtocol, schemaVersion: 1, identity: { organizationId: row.organizationId, signatureId: row.signatureId, intentId: row.id, attemptId: attempt.id, evidenceId: id,
    commandHash: row.commandHash, providerScopeHash: row.providerScopeHash, contractHash: snapshot.contractHash, originalPdfSha256: snapshot.document.sha256 }, ...value }, deps.env), now = await repository.clock();
  const recorded = await repository.appendPreparationEvidence({ id, attemptId: attempt.id, signatureId: row.signatureId, phase: row.phase, kind: value.kind, webhookId: value.webhook?.id ?? null, identityRecoveryId: value.identityRecovery?.id ?? null, signedArchiveId: value.signedArchive?.id ?? null, providerScopeHash: row.providerScopeHash,
    providerRequestId: value.providerRequestId, providerState: value.kind === "UNCERTAIN" ? null : value.observation?.status ?? null, originalPdfSha256: sealed.identity.originalPdfSha256, contractHash: sealed.identity.contractHash,
    observationHash, payloadSha256: sealed.identity.sha256, payloadByteSize: sealed.identity.byteSize, payloadCipher: sealed.cipher, observedAt: now });
  await writeAuditEvent(tx, { organizationId: row.organizationId, actorId: null, action: "documents.signature.provider_observed", resourceType: "signature", resourceId: id,
    after: { signatureId: row.signatureId, intentId: row.id, attemptId: attempt.id, evidenceId: id, kind: value.kind, payloadSha256: sealed.identity.sha256, observationHash }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
  if (["SENT", "VIEWED", "DECLINED", "EXPIRED", "SIGNED"].includes(value.kind)) {
    const archive = value.kind === "SIGNED" ? value.signedArchive : null, completedAt = archive ? new Date(Math.max(...value.observation!.recipients.filter(recipient => ["SIGNER", "APPROVER"].includes(recipient.role)).map(recipient => Date.parse(recipient.signedAt!)))) : null;
    if (archive && (!archive.signedVersionId || !archive.certificateVersionId || !completedAt || !Number.isFinite(completedAt.getTime()) || completedAt > now)) throw new DocumentConflictError();
    const eventId = randomUUID(); await repository.appendSignatureEvent({ id: eventId, signatureId: row.signatureId, state: value.kind, providerIdentityHash: row.providerScopeHash, providerRequestId: value.providerRequestId,
      providerEventId: archive ? "native-signed-archive:" + archive.id : value.webhook ? "native-webhook:" + value.webhook.providerEventId + ":" + value.kind : "native-distribution:" + id, providerEvidenceId: id, evidenceHash: sealed.identity.sha256, evidenceCipher: sealed.cipher, signedVersionId: archive?.signedVersionId ?? null, occurredAt: completedAt ?? (value.webhook ? new Date(value.webhook.occurredAt) : now), observedAt: now });
    await writeAuditEvent(tx, { organizationId: row.organizationId, actorId: null, action: "documents.signature." + value.kind.toLowerCase(), resourceType: "signature", resourceId: row.signatureId,
      after: { signatureId: row.signatureId, intentId: row.id, attemptId: attempt.id, evidenceId: id, signatureEventId: eventId, ...archive ? { signedArchiveId: archive.id, signedVersionId: archive.signedVersionId, certificateVersionId: archive.certificateVersionId } : {} }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
  }
  return recorded;
}
