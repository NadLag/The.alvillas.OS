import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import type { SignatureProvider } from "@/platform/providers";
import { captureSignatureRequest, assertSignatureRequestObservation, assertDistributedSignatureRequestObservation, signatureRequestObservationSchema, signatureObservationFactsSchema, type SignatureRequestReceipt } from "@/platform/providers/signature-request";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { signatureDistributionRequested } from "../domain/document-signature-distribution";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { captureSignatureProviderReceipt, readSignatureProviderScope, signatureProviderBoundary } from "../infrastructure/signature-provider-boundary";
import { documentActorContext, downloadDocumentVersion, type DocumentActorContext } from "./document-archive";
import { configuredDocumentObjects } from "./document-files";
import { originalSignatureDistribution, signatureDistributionOutboxKey, type SignatureDistributionDependencies } from "./document-signature-distribution";
import { nativeSignatureDistributionContext } from "./document-signature-distribution-context";
import { readSignaturePreparationEvidence } from "./document-signature-preparation";
import { appendNativeSignatureProviderEvidence, readNativeSignatureProviderEvidence, type SignatureProviderObservation } from "./document-signature-provider-evidence";

const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ intentId: z.uuid() }).strict();
type Reference = z.infer<typeof referenceSchema>;
type Dependencies = Omit<SignatureDistributionDependencies, "db"> & { db?: SignatureDistributionDependencies["db"]; provider?: Pick<SignatureProvider, "distributeSignatureRequest" | "readSignatureRequest" | "downloadSignatureRequest">; providerOrigin?: string; reconcileActor?: DocumentActorContext };
async function referenced(tx: TenantTransaction, reference: Reference) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload);
  if (!event || event.type !== signatureDistributionRequested || !payload.success) throw new DocumentAccessError();
  const repository = new SignaturePreparationRepository(tx, reference.organizationId), row = await repository.distribution(payload.data.intentId);
  if (!row || event.idempotencyKey !== signatureDistributionOutboxKey(row.requestedBy, row.commandKey) || event.occurredAt.getTime() !== row.requestedAt.getTime()) throw new DocumentAccessError();
  const original = originalSignatureDistribution(row), actor = documentActorContext({ organizationId: reference.organizationId, actorId: row.requestedBy, authContext: restoreAuthorizationCap(row.authorizationCap) });
  return { repository, row, original, actor };
}
type Original = Awaited<ReturnType<typeof referenced>>;
async function authorized(tx: TenantTransaction, original: Original, env?: NodeJS.ProcessEnv, reconcileActor?: DocumentActorContext) {
  const actor = reconcileActor ? documentActorContext(reconcileActor) : original.actor; if (actor.organizationId !== original.row.organizationId) throw new DocumentAccessError();
  const current = await nativeSignatureDistributionContext(actor, tx, original.original.snapshot.command.preparationId, env), snapshot = original.original.snapshot;
  if (current.fingerprint !== snapshot.contextFingerprint || current.contractHash !== snapshot.contractHash || current.row.commandHash !== snapshot.signatureCommandHash ||
    current.providerScopeHash !== original.row.providerScopeHash || current.retainedPreparation.evidenceId !== snapshot.preparation.evidenceId || current.retainedPreparation.providerRequestId !== snapshot.preparation.providerRequestId) throw new DocumentConflictError();
  return current;
}
const summary = (intentId: string, state: "SENT" | "UNCERTAIN" | "SUPERSEDED") => ({ intentId, state });
async function retain(reference: Reference, attemptId: string, value: SignatureProviderObservation, deps: Dependencies) {
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const original = await referenced(tx, reference), { repository, row } = original; await repository.lock("signature-provider:" + row.signatureId);
    const attempt = await repository.distributionAttempt(row.signatureId); if (!attempt || attempt.id !== attemptId || attempt.intentId !== row.id) throw new DocumentConflictError();
    return appendNativeSignatureProviderEvidence(tx, repository, row, attempt, original.original.snapshot, value, deps);
  });
}
export async function executeSignatureDistributionReference(raw: unknown, deps: Dependencies = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, initial = await withTenant(db, reference.organizationId, tx => referenced(tx, reference)),
    previous = await withTenant(db, reference.organizationId, tx => new SignaturePreparationRepository(tx, reference.organizationId).distributionAttempt(initial.row.signatureId));
  if (previous && previous.intentId !== initial.row.id) return summary(initial.row.id, "SUPERSEDED");
  const confirmed = () => withTenant(db, reference.organizationId, tx => new SignaturePreparationRepository(tx, reference.organizationId).signatureSent(initial.row.signatureId, initial.row.providerScopeHash, initial.original.snapshot.preparation.providerRequestId));
  if (await confirmed()) return summary(initial.row.id, "SENT");
  if (deps.reconcileActor && !previous) throw new DocumentConflictError();
  if (previous?.evidence.some(item => item.kind === "SENT")) return summary(initial.row.id, "SENT");
  const actor = deps.reconcileActor ? documentActorContext(deps.reconcileActor) : initial.actor;
  const current = await withTenant(db, reference.organizationId, async tx => authorized(tx, await referenced(tx, reference), deps.env, actor)), account = current.policy.value.account, { origin, provider } = signatureProviderBoundary(account, deps),
    scopeProof = await readSignatureProviderScope(provider, account, origin), prepared = readSignaturePreparationEvidence(current.preparation, current.preparationEvidence, deps.env),
    file = await downloadDocumentVersion(actor, { versionId: current.current.version.id }, { ...deps, db, objects: deps.objects ?? configuredDocumentObjects() }),
    input = captureSignatureRequest({ ...current.metadata, file: { ...current.metadata.file, bytes: file.bytes } }), requestId = current.retainedPreparation.providerRequestId;
  if (prepared.kind !== "PREPARED" || !prepared.prepareReceipt || prepared.providerRequestId !== requestId) throw new DocumentConflictError();
  // Verify the original private envelope immediately before a first send. A
  // redelivery can only reconcile this already-known identity through GETs.
  if (!previous) {
    try {
    const observation = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId, reference: input.reference })); if (observation.items.length !== 1) throw new DocumentConflictError();
    const download = await provider.downloadSignatureRequest({ requestId, reference: input.reference, itemId: observation.items[0].id, version: "original" });
    if (download.requestId !== requestId || download.itemId !== observation.items[0].id || download.version !== "original" || download.sha256 !== input.file.sha256) throw new DocumentConflictError();
    assertSignatureRequestObservation(input, observation, { requestId, teamId: account.teamId, distributionMethod: "NONE", originalPdf: download.bytes });
    assertSignatureRequestObservation(input, signatureRequestObservationSchema.parse(download.observation), { requestId, teamId: account.teamId, distributionMethod: "NONE", originalPdf: download.bytes });
    } catch (error) {
      const competing = await withTenant(db, reference.organizationId, tx => new SignaturePreparationRepository(tx, reference.organizationId).distributionAttempt(initial.row.signatureId));
      if (competing) return summary(initial.row.id, competing.intentId !== initial.row.id ? "SUPERSEDED" : competing.evidence.some(item => item.kind === "SENT") ? "SENT" : "UNCERTAIN");
      throw error;
    }
  }
  const start = await withTenant(db, reference.organizationId, async tx => {
    const original = await referenced(tx, reference), { repository, row } = original; await repository.lock("signature-provider:" + row.signatureId);
    const existing = await repository.distributionAttempt(row.signatureId); if (existing) return { attempt: existing, post: false };
    if (deps.reconcileActor) throw new DocumentConflictError();
    const checked = await authorized(tx, original, deps.env); if (checked.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    const id = randomUUID(), now = await repository.clock(), attempt = await repository.appendPreparationAttempt({ id, intentId: row.id, signatureId: row.signatureId, phase: "SEND", startedAt: now });
    await writeAuditEvent(tx, { organizationId: row.organizationId, actorId: null, action: "documents.signature.preparation_started", resourceType: "signature", resourceId: id,
      after: { signatureId: row.signatureId, intentId: row.id, attemptId: id, commandHash: row.commandHash }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    if ((await authorized(tx, original, deps.env)).fingerprint !== checked.fingerprint) throw new DocumentConflictError(); return { attempt, post: true };
  });
  if (start.attempt.intentId !== initial.row.id) return summary(initial.row.id, "SUPERSEDED");
  // A competing delivery that observed no committed attempt must not inspect a
  // still-in-flight effect or send again. A later known-attempt delivery reconciles.
  if (!start.post && !previous) return summary(initial.row.id, "UNCERTAIN");
  const old = previous?.evidence.map(evidence => readNativeSignatureProviderEvidence(initial.row, evidence, initial.original.snapshot, deps.env)).find(value => value.distributionReceipt);
  let receipt: SignatureRequestReceipt | null = old?.distributionReceipt ? captureSignatureProviderReceipt({ requestId, evidence: new Uint8Array(Buffer.from(old.distributionReceipt, "base64")) }) : null;
  const unconfirmed = (failureCode: SignatureProviderObservation["failureCode"]): SignatureProviderObservation => ({ kind: "UNCERTAIN", providerRequestId: requestId, prepareReceipt: prepared.prepareReceipt, observation: null, observationReceipt: null,
    distributionReceipt: receipt ? Buffer.from(receipt.evidence).toString("base64") : null, distributionProof: receipt ? "POST_ACKNOWLEDGED" : null, scopeProof, failureCode });
  if (start.post) {
    try { receipt = captureSignatureProviderReceipt(await provider.distributeSignatureRequest({ requestId })); if (receipt.requestId !== requestId) { receipt = null; throw new DocumentConflictError(); } }
    catch { await retain(reference, start.attempt.id, unconfirmed("SIGNATURE_OUTCOME_UNCONFIRMED"), deps); return summary(initial.row.id, await confirmed() ? "SENT" : "UNCERTAIN"); }
    await retain(reference, start.attempt.id, unconfirmed("SIGNATURE_OUTCOME_UNCONFIRMED"), deps);
  }
  try {
    const observation = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId, reference: input.reference })); if (observation.items.length !== 1) throw new DocumentConflictError();
    const download = await provider.downloadSignatureRequest({ requestId, reference: input.reference, itemId: observation.items[0].id, version: "original" });
    if (download.requestId !== requestId || download.itemId !== observation.items[0].id || download.version !== "original" || download.sha256 !== input.file.sha256) throw new DocumentConflictError();
    assertDistributedSignatureRequestObservation(input, observation, { requestId, teamId: account.teamId, originalPdf: download.bytes });
    const final = signatureRequestObservationSchema.parse(download.observation); assertDistributedSignatureRequestObservation(input, final, { requestId, teamId: account.teamId, originalPdf: download.bytes });
    await retain(reference, start.attempt.id, { kind: "SENT", providerRequestId: requestId, prepareReceipt: prepared.prepareReceipt, observation: signatureObservationFactsSchema.strip().parse(final), observationReceipt: Buffer.from(final.evidence).toString("base64"),
      distributionReceipt: receipt ? Buffer.from(receipt.evidence).toString("base64") : null, distributionProof: receipt ? "POST_ACKNOWLEDGED" : "READBACK_RECONCILED", scopeProof, failureCode: null }, deps);
    return summary(initial.row.id, "SENT");
  } catch { if (await confirmed()) return summary(initial.row.id, "SENT"); await retain(reference, start.attempt.id, unconfirmed("SIGNATURE_CONTRACT_UNCONFIRMED"), deps); return summary(initial.row.id, "UNCERTAIN"); }
}
