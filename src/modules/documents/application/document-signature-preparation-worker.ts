import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import type { SignatureProvider } from "@/platform/providers";
import { captureSignatureRequest, assertSignatureRequestObservation, signatureRequestObservationSchema, signatureObservationFactsSchema, type SignatureRequestInput, type SignatureRequestReceipt } from "@/platform/providers/signature-request";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { signaturePreparationRequested } from "../domain/document-signature-preparation";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { signatureProviderBoundary, captureSignatureProviderReceipt, readSignatureProviderScope } from "../infrastructure/signature-provider-boundary";
import { documentPdfPageCount } from "../infrastructure/document-pdf-metadata";
import { documentActorContext, downloadDocumentVersion } from "./document-archive";
import { configuredDocumentObjects } from "./document-files";
import { nativeSignaturePreparationContext } from "./document-signature-preparation-context";
import { originalSignaturePreparation, readSignaturePreparationEvidence, signaturePreparationOutboxKey, type SignaturePreparationDependencies } from "./document-signature-preparation";
import { appendNativeSignatureProviderEvidence, type SignatureProviderObservation } from "./document-signature-provider-evidence";

const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ intentId: z.uuid() }).strict();
type Reference = z.infer<typeof referenceSchema>;
type Dependencies = Omit<SignaturePreparationDependencies, "db"> & { db?: SignaturePreparationDependencies["db"]; provider?: Pick<SignatureProvider, "prepareSignatureRequest" | "readSignatureRequest" | "downloadSignatureRequest">; providerOrigin?: string };
async function referenced(tx: TenantTransaction, reference: Reference) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload);
  if (!event || event.type !== signaturePreparationRequested || !payload.success) throw new DocumentAccessError();
  const repository = new SignaturePreparationRepository(tx, reference.organizationId), row = await repository.preparation(payload.data.intentId);
  if (!row || event.idempotencyKey !== signaturePreparationOutboxKey(row.requestedBy, row.commandKey) || event.occurredAt.getTime() !== row.requestedAt.getTime()) throw new DocumentAccessError();
  const original = originalSignaturePreparation(row), actor = documentActorContext({ organizationId: reference.organizationId, actorId: row.requestedBy, authContext: restoreAuthorizationCap(row.authorizationCap) });
  return { repository, row, original, actor };
}
type Original = Awaited<ReturnType<typeof referenced>>;
async function authorized(tx: TenantTransaction, original: Original, env?: NodeJS.ProcessEnv) {
  const current = await nativeSignaturePreparationContext(original.actor, tx, original.original.draft, "create", env), snapshot = original.original.snapshot;
  if (current.fingerprint !== snapshot.contextFingerprint || current.contractHash !== snapshot.contractHash || current.row.commandHash !== snapshot.signatureCommandHash || current.providerScopeHash !== original.row.providerScopeHash) throw new DocumentConflictError();
  const scope = await original.repository.scope(current.providerScopeHash);
  if (!scope || scope.origin !== current.policy.value.account.origin || scope.teamId !== current.policy.value.account.teamId) throw new DocumentConfigurationError();
  return current;
}
const summary = (intentId: string, state: "PREPARED" | "UNCERTAIN" | "SUPERSEDED") => ({ intentId, state });
async function retain(reference: Reference, attemptId: string, value: SignatureProviderObservation, deps: Dependencies) {
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const original = await referenced(tx, reference), { repository, row } = original; await repository.lock("signature-provider:" + row.signatureId);
    const attempt = await repository.preparationAttempt(row.signatureId); if (!attempt || attempt.id !== attemptId || attempt.intentId !== row.id) throw new DocumentConflictError();
    // Provider facts belong to the already-authorized immutable attempt. A later
    // offboarding or grant change cannot erase the actual external receipt.
    return appendNativeSignatureProviderEvidence(tx, repository, row, attempt, original.original.snapshot, value, deps);
  });
}
export async function executeSignaturePreparationReference(raw: unknown, deps: Dependencies = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, initial = await withTenant(db, reference.organizationId, tx => referenced(tx, reference)),
    previous = await withTenant(db, reference.organizationId, tx => new SignaturePreparationRepository(tx, reference.organizationId).preparationAttempt(initial.row.signatureId));
  if (previous?.intentId !== undefined && previous.intentId !== initial.row.id) return summary(initial.row.id, "SUPERSEDED");
  if (previous?.evidence.some(item => item.kind === "PREPARED")) return summary(initial.row.id, "PREPARED");
  const retained = previous?.evidence.map(row => readSignaturePreparationEvidence(initial.row, row, deps.env)).find(item => item.providerRequestId && item.prepareReceipt);
  if (previous && !retained) return summary(initial.row.id, "UNCERTAIN");
  const current = await withTenant(db, reference.organizationId, async tx => authorized(tx, await referenced(tx, reference), deps.env)), { origin, provider } = signatureProviderBoundary(current.policy.value.account, deps);
  const objects = deps.objects ?? configuredDocumentObjects(), file = await downloadDocumentVersion(initial.actor, { versionId: current.current.version.id }, { ...deps, db, objects }), pages = await documentPdfPageCount(file.bytes);
  if (initial.original.draft.recipients.some(recipient => recipient.fields.some(field => field.page > pages))) throw new DocumentConflictError();
  const input: SignatureRequestInput = captureSignatureRequest({ ...current.metadata, file: { ...current.metadata.file, bytes: file.bytes } }), account = current.policy.value.account, scopeProof = await readSignatureProviderScope(provider, account, origin);
  const start = await withTenant(db, reference.organizationId, async tx => {
    const original = await referenced(tx, reference), { repository, row } = original; await repository.lock("signature-provider:" + row.signatureId);
    const existing = await repository.preparationAttempt(row.signatureId); if (existing) return { attempt: existing, post: false };
    const checked = await authorized(tx, original, deps.env); if (checked.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    const id = randomUUID(), now = await repository.clock(), attempt = await repository.appendPreparationAttempt({ id, intentId: row.id, signatureId: row.signatureId, phase: "PREPARE", startedAt: now });
    await writeAuditEvent(tx, { organizationId: row.organizationId, actorId: null, action: "documents.signature.preparation_started", resourceType: "signature", resourceId: id,
      after: { signatureId: row.signatureId, intentId: row.id, attemptId: id, commandHash: row.commandHash }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    if ((await authorized(tx, original, deps.env)).fingerprint !== checked.fingerprint) throw new DocumentConflictError(); return { attempt, post: true };
  });
  if (start.attempt.intentId !== initial.row.id) return summary(initial.row.id, "SUPERSEDED");
  if (!start.post && !retained) return summary(initial.row.id, "UNCERTAIN");
  let receipt: SignatureRequestReceipt | null = retained?.providerRequestId && retained.prepareReceipt ? captureSignatureProviderReceipt({ requestId: retained.providerRequestId, evidence: new Uint8Array(Buffer.from(retained.prepareReceipt, "base64")) }) : null;
  const unconfirmed = (failureCode: SignatureProviderObservation["failureCode"]): SignatureProviderObservation => ({ kind: "UNCERTAIN", providerRequestId: receipt?.requestId ?? null, prepareReceipt: receipt ? Buffer.from(receipt.evidence).toString("base64") : null, observation: null, observationReceipt: null, scopeProof, failureCode });
  if (start.post) {
    try { receipt = captureSignatureProviderReceipt(await provider.prepareSignatureRequest(input)); }
    catch { await retain(reference, start.attempt.id, unconfirmed("SIGNATURE_OUTCOME_UNCONFIRMED"), deps); return summary(initial.row.id, "UNCERTAIN"); }
    // Commit the real creation acknowledgement before dependent network reads.
    await retain(reference, start.attempt.id, unconfirmed("SIGNATURE_OUTCOME_UNCONFIRMED"), deps);
  }
  if (!receipt) return summary(initial.row.id, "UNCERTAIN");
  try {
    const observation = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId: receipt.requestId, reference: input.reference }));
    if (observation.items.length !== 1) throw new DocumentConflictError();
    const download = await provider.downloadSignatureRequest({ requestId: receipt.requestId, reference: input.reference, itemId: observation.items[0].id, version: "original" });
    if (download.requestId !== receipt.requestId || download.itemId !== observation.items[0].id || download.version !== "original" || download.sha256 !== input.file.sha256) throw new DocumentConflictError();
    assertSignatureRequestObservation(input, observation, { requestId: receipt.requestId, teamId: account.teamId, distributionMethod: "NONE", originalPdf: download.bytes });
    const final = signatureRequestObservationSchema.parse(download.observation);
    assertSignatureRequestObservation(input, final, { requestId: receipt.requestId, teamId: account.teamId, distributionMethod: "NONE", originalPdf: download.bytes });
    await retain(reference, start.attempt.id, { kind: "PREPARED", providerRequestId: receipt.requestId, prepareReceipt: Buffer.from(receipt.evidence).toString("base64"), observation: signatureObservationFactsSchema.strip().parse(final), observationReceipt: Buffer.from(final.evidence).toString("base64"), scopeProof, failureCode: null }, deps);
    return summary(initial.row.id, "PREPARED");
  } catch {
    await retain(reference, start.attempt.id, unconfirmed("SIGNATURE_CONTRACT_UNCONFIRMED"), deps); return summary(initial.row.id, "UNCERTAIN");
  }
}
