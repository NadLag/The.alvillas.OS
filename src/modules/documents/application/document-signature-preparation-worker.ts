import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumensoSignatureProvider } from "@/platform/providers/real";
import type { SignatureProvider } from "@/platform/providers";
import { captureSignatureRequest, assertSignatureRequestObservation, signatureRequestIdSchema, signatureRequestObservationSchema, signatureObservationFactsSchema, signatureMaximumEvidenceBytes, type SignatureRequestInput, type SignatureRequestReceipt } from "@/platform/providers/signature-request";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { signaturePreparationRequested } from "../domain/document-signature-preparation";
import { signatureProviderEvidenceProtocol, type signatureProviderEvidencePayloadSchema } from "../domain/document-signature-provider-evidence";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { openSignatureProviderEvidence, sealSignatureProviderEvidence } from "../infrastructure/signature-provider-payload";
import { documentPdfPageCount } from "../infrastructure/document-pdf-metadata";
import { documentActorContext, downloadDocumentVersion } from "./document-archive";
import { configuredDocumentObjects } from "./document-files";
import { nativeSignaturePreparationContext } from "./document-signature-preparation-context";
import { originalSignaturePreparation, signaturePreparationOutboxKey, type SignaturePreparationDependencies } from "./document-signature-preparation";

const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ intentId: z.uuid() }).strict();
type Reference = z.infer<typeof referenceSchema>;
type Payload = z.infer<typeof signatureProviderEvidencePayloadSchema>;
type Dependencies = Omit<SignaturePreparationDependencies, "db"> & { db?: SignaturePreparationDependencies["db"]; provider?: Pick<SignatureProvider, "prepareSignatureRequest" | "readSignatureRequest" | "downloadSignatureRequest">; providerOrigin?: string };
type Evidence = Awaited<ReturnType<SignaturePreparationRepository["appendPreparationEvidence"]>>;
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
function evidencePayload(row: Evidence, original: Original, env?: NodeJS.ProcessEnv) {
  return openSignatureProviderEvidence({ organizationId: original.row.organizationId, signatureId: original.row.signatureId, intentId: original.row.id, attemptId: row.attemptId, evidenceId: row.id,
    commandHash: original.row.commandHash, providerScopeHash: original.row.providerScopeHash, contractHash: original.original.snapshot.contractHash, originalPdfSha256: original.original.snapshot.document.sha256,
    sha256: row.payloadSha256, byteSize: row.payloadByteSize }, row.payloadCipher, env);
}
function providerOrigin(raw: string | undefined) {
  try { const value = new URL(raw ?? ""); if (value.username || value.password || value.search || value.hash || !["", "/"].includes(value.pathname)) throw new Error(); return value.origin; }
  catch { throw new DocumentConfigurationError(); }
}
function capturedReceipt(raw: SignatureRequestReceipt): SignatureRequestReceipt {
  if (!signatureRequestIdSchema.safeParse(raw.requestId).success || !(raw.evidence instanceof Uint8Array) || raw.evidence.length < 1 || raw.evidence.length > signatureMaximumEvidenceBytes) throw new DocumentConflictError();
  return { requestId: raw.requestId, evidence: new Uint8Array(raw.evidence) };
}
const summary = (intentId: string, state: "PREPARED" | "UNCERTAIN" | "SUPERSEDED") => ({ intentId, state });
async function retain(reference: Reference, attemptId: string, value: Omit<Payload, "identity" | "protocol" | "schemaVersion">, deps: Dependencies) {
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const original = await referenced(tx, reference), { repository, row } = original; await repository.lock("signature-provider:" + row.signatureId);
    const attempt = await repository.preparationAttempt(row.signatureId); if (!attempt || attempt.id !== attemptId || attempt.intentId !== row.id) throw new DocumentConflictError();
    // Provider facts belong to the already-authorized immutable attempt. A later
    // offboarding or grant change cannot erase the actual external receipt.
    const observationHash = commandFingerprint(value), existing = await repository.preparationEvidence(attempt.id, observationHash); if (existing) return existing;
    if (value.kind === "PREPARED") { const prepared = attempt.evidence.find(item => item.kind === "PREPARED"); if (prepared) return prepared; }
    const id = randomUUID(), sealed = sealSignatureProviderEvidence({ protocol: signatureProviderEvidenceProtocol, schemaVersion: 1, identity: { organizationId: row.organizationId, signatureId: row.signatureId, intentId: row.id, attemptId: attempt.id, evidenceId: id,
      commandHash: row.commandHash, providerScopeHash: row.providerScopeHash, contractHash: original.original.snapshot.contractHash, originalPdfSha256: original.original.snapshot.document.sha256 }, ...value }, deps.env), now = await repository.clock();
    const recorded = await repository.appendPreparationEvidence({ id, attemptId: attempt.id, signatureId: row.signatureId, phase: "PREPARE", kind: value.kind, providerScopeHash: row.providerScopeHash,
      providerRequestId: value.providerRequestId, providerState: value.observation?.status ?? null, originalPdfSha256: sealed.identity.originalPdfSha256, contractHash: sealed.identity.contractHash,
      observationHash, payloadSha256: sealed.identity.sha256, payloadByteSize: sealed.identity.byteSize, payloadCipher: sealed.cipher, observedAt: now });
    await writeAuditEvent(tx, { organizationId: row.organizationId, actorId: null, action: "documents.signature.provider_observed", resourceType: "signature", resourceId: id,
      after: { signatureId: row.signatureId, intentId: row.id, attemptId: attempt.id, evidenceId: id, kind: value.kind, payloadSha256: sealed.identity.sha256, observationHash }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    return recorded;
  });
}
export async function executeSignaturePreparationReference(raw: unknown, deps: Dependencies = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, initial = await withTenant(db, reference.organizationId, tx => referenced(tx, reference)),
    previous = await withTenant(db, reference.organizationId, tx => new SignaturePreparationRepository(tx, reference.organizationId).preparationAttempt(initial.row.signatureId));
  if (previous?.intentId !== undefined && previous.intentId !== initial.row.id) return summary(initial.row.id, "SUPERSEDED");
  if (previous?.evidence.some(item => item.kind === "PREPARED")) return summary(initial.row.id, "PREPARED");
  const retained = previous?.evidence.map(row => evidencePayload(row, initial, deps.env)).find(item => item.providerRequestId && item.prepareReceipt);
  if (previous && !retained) return summary(initial.row.id, "UNCERTAIN");
  const current = await withTenant(db, reference.organizationId, async tx => authorized(tx, await referenced(tx, reference), deps.env)),
    env = deps.env ?? process.env, origin = providerOrigin(deps.provider ? deps.providerOrigin : env.DOCUMENSO_URL);
  if (origin !== current.policy.value.account.origin) throw new DocumentConfigurationError();
  const objects = deps.objects ?? configuredDocumentObjects(), file = await downloadDocumentVersion(initial.actor, { versionId: current.current.version.id }, { ...deps, db, objects }), pages = await documentPdfPageCount(file.bytes);
  if (initial.original.draft.recipients.some(recipient => recipient.fields.some(field => field.page > pages))) throw new DocumentConflictError();
  const input: SignatureRequestInput = captureSignatureRequest({ ...current.metadata, file: { ...current.metadata.file, bytes: file.bytes } }), provider = deps.provider ?? new DocumensoSignatureProvider(env), account = current.policy.value.account,
    scopeObservation = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId: account.scopeEnvelopeId, reference: account.scopeReference }));
  if (scopeObservation.requestId !== account.scopeEnvelopeId || scopeObservation.reference !== account.scopeReference || scopeObservation.teamId !== account.teamId) throw new DocumentConfigurationError();
  const scopeProof: Payload["scopeProof"] = { requestId: scopeObservation.requestId, reference: scopeObservation.reference, teamId: scopeObservation.teamId, origin, fingerprint: commandFingerprint(signatureObservationFactsSchema.strip().parse(scopeObservation)) };
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
  let receipt: SignatureRequestReceipt | null = retained?.providerRequestId && retained.prepareReceipt ? capturedReceipt({ requestId: retained.providerRequestId, evidence: new Uint8Array(Buffer.from(retained.prepareReceipt, "base64")) }) : null;
  const unconfirmed = (failureCode: Payload["failureCode"]): Omit<Payload, "identity" | "protocol" | "schemaVersion"> => ({ kind: "UNCERTAIN", providerRequestId: receipt?.requestId ?? null, prepareReceipt: receipt ? Buffer.from(receipt.evidence).toString("base64") : null, observation: null, observationReceipt: null, scopeProof, failureCode });
  if (start.post) {
    try { receipt = capturedReceipt(await provider.prepareSignatureRequest(input)); }
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
