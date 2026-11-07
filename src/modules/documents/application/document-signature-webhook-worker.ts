import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import type { SignatureProvider } from "@/platform/providers";
import { captureSignatureRequest, assertSignatureRequestObservation, signatureRequestObservationSchema, signatureObservationFactsSchema } from "@/platform/providers/signature-request";
import { DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { signatureWebhookIdentitySchema, signatureWebhookReceived } from "../domain/document-signature-webhook";
import { SignatureWebhookRepository } from "../infrastructure/signature-webhook-repository";
import { openSignatureWebhook } from "../infrastructure/document-signature-webhook-payload";
import { parseDocumensoWebhookEvidence } from "../infrastructure/documenso-webhook";
import { readSignatureProviderScope, signatureProviderBoundary } from "../infrastructure/signature-provider-boundary";
import { retainedSignatureProviderContract } from "./document-signature-retained-contract";
import { signatureWebhookOutboxKey } from "./document-signature-webhook";
import { classifySignatureWebhook } from "./document-signature-webhook-observation";
import { appendNativeSignatureProviderEvidence, readNativeSignatureProviderEvidence, type SignatureProviderObservation } from "./document-signature-provider-evidence";

const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ webhookId: z.uuid() }).strict();
type Reference = z.infer<typeof referenceSchema>;
type Dependencies = { db?: TenantTransactionRunner; env?: NodeJS.ProcessEnv; requestId?: string; provider?: Pick<SignatureProvider, "readSignatureRequest" | "downloadSignatureRequest">; providerOrigin?: string };
async function referenced(tx: TenantTransaction, reference: Reference, env?: NodeJS.ProcessEnv) {
  const repository = new SignatureWebhookRepository(tx, reference.organizationId), event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload), row = payload.success ? await repository.webhook(payload.data.webhookId) : null;
  if (!event || event.type !== signatureWebhookReceived || !row || event.idempotencyKey !== signatureWebhookOutboxKey(row.id) || event.occurredAt.getTime() !== row.receivedAt.getTime()) throw new DocumentAccessError();
  const identity = signatureWebhookIdentitySchema.parse({ organizationId: row.organizationId, webhookId: row.id, signatureId: row.signatureId, preparationAttemptId: row.preparationAttemptId, providerScopeHash: row.providerScopeHash, providerRequestId: row.providerRequestId, providerEventId: row.providerEventId, eventType: row.eventType, occurredAt: row.occurredAt.toISOString(), payloadSha256: row.payloadSha256, payloadByteSize: row.payloadByteSize }), facts = parseDocumensoWebhookEvidence(openSignatureWebhook(identity, row.payloadCipher, env));
  if (facts.eventId !== row.providerEventId || facts.event !== row.eventType || facts.createdAt !== identity.occurredAt || facts.requestId !== row.providerRequestId || facts.evidenceSha256 !== row.payloadSha256 || facts.reference !== null && facts.reference !== row.signatureId) throw new DocumentConflictError();
  const attempt = await repository.preparationAttempt(row.signatureId); if (!attempt || attempt.id !== row.preparationAttemptId) throw new DocumentConflictError(); const original = await retainedSignatureProviderContract(tx, reference.organizationId, attempt.intentId, env);
  const originalIds = new Set(attempt.evidence.filter(item => item.webhookId === null && item.providerRequestId !== null).map(item => item.providerRequestId));
  // A callback can be retained before the creation acknowledgement commits, but
  // an unknown creation effect cannot be bound to a guessed or copied envelope.
  if (originalIds.size !== 1 || !originalIds.has(row.providerRequestId)) throw new DocumentConflictError();
  if (original.intent.providerScopeHash !== row.providerScopeHash || original.signature.id !== row.signatureId) throw new DocumentConflictError(); return { repository, row, facts, attempt, original };
}
async function retain(reference: Reference, value: SignatureProviderObservation, complete: boolean, deps: Dependencies) {
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const current = await referenced(tx, reference, deps.env); await current.repository.lock("signature-provider:" + current.row.signatureId);
    const recorded = await current.repository.webhookEvidence(current.row.id); if (value.kind !== "UNCERTAIN" && recorded.some(row => row.kind !== "UNCERTAIN")) return;
    const original = current.original, attempt = await current.repository.preparationAttempt(current.row.signatureId); if (!attempt || attempt.id !== current.attempt.id) throw new DocumentConflictError();
    let observed = value; if (observed.kind === "SENT" && await current.repository.signatureSent(current.row.signatureId, current.row.providerScopeHash, current.row.providerRequestId)) observed = { ...observed, kind: "OBSERVED", distributionProof: null };
    await appendNativeSignatureProviderEvidence(tx, current.repository, original.intent, attempt, original.original.snapshot, observed, deps);
    if (complete) await appendNativeSignatureProviderEvidence(tx, current.repository, original.intent, attempt, original.original.snapshot, { ...observed, kind: "COMPLETION", distributionProof: null, distributionReceipt: null }, deps);
  });
}
export async function executeSignatureWebhookReference(raw: unknown, deps: Dependencies = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, current = await withTenant(db, reference.organizationId, async tx => { const source = await referenced(tx, reference, deps.env); return { ...source, recorded: await source.repository.webhookEvidence(source.row.id) }; });
  if (current.recorded.some(row => row.kind !== "UNCERTAIN")) return { webhookId: current.row.id, state: "RECORDED" as const };
  const { origin, provider } = signatureProviderBoundary(current.original.policy.account, deps), webhook = { id: current.row.id, providerEventId: current.row.providerEventId, payloadSha256: current.row.payloadSha256, occurredAt: current.row.occurredAt.toISOString() };
  let scopeProof: Awaited<ReturnType<typeof readSignatureProviderScope>> | null = null;
  try {
    scopeProof = await readSignatureProviderScope(provider, current.original.policy.account, origin);
    const requestId = current.row.providerRequestId, first = signatureRequestObservationSchema.parse(await provider.readSignatureRequest({ requestId, reference: current.row.signatureId })); if (first.items.length !== 1) throw new DocumentConflictError();
    const download = await provider.downloadSignatureRequest({ requestId, reference: current.row.signatureId, itemId: first.items[0].id, version: "original" }); if (download.requestId !== requestId || download.itemId !== first.items[0].id || download.version !== "original" || download.sha256 !== current.original.version.admission.sha256) throw new DocumentConflictError();
    const input = captureSignatureRequest({ ...current.original.metadata, file: { ...current.original.metadata.file, bytes: download.bytes } }), final = signatureRequestObservationSchema.parse(download.observation);
    for (const actual of [first, final]) assertSignatureRequestObservation(input, actual, { requestId, teamId: current.original.policy.account.teamId, distributionMethod: actual.distributionMethod, originalPdf: download.bytes });
    const classification = classifySignatureWebhook(current.facts, final), previousReceipt = current.attempt.evidence.map(row => readNativeSignatureProviderEvidence(current.original.intent, row, current.original.original.snapshot, deps.env)).find(value => value.prepareReceipt)?.prepareReceipt ?? null,
      value: SignatureProviderObservation = { kind: classification.kind, providerRequestId: requestId, observation: signatureObservationFactsSchema.strip().parse(final), prepareReceipt: previousReceipt, observationReceipt: Buffer.from(final.evidence).toString("base64"), scopeProof, failureCode: null, webhook, distributionReceipt: null, distributionProof: classification.kind === "SENT" ? "WEBHOOK_READBACK" : null };
    await retain(reference, value, classification.completionObserved, deps); return { webhookId: current.row.id, state: "RECORDED" as const };
  } catch {
    if (scopeProof) await retain(reference, { kind: "UNCERTAIN", providerRequestId: current.row.providerRequestId, observation: null, prepareReceipt: null, observationReceipt: null, scopeProof, failureCode: "SIGNATURE_CONTRACT_UNCONFIRMED", webhook }, false, deps);
    else await withTenant(db, reference.organizationId, async tx => { const source = await referenced(tx, reference, deps.env); await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "documents.signature.webhook_observation_blocked", resourceType: "signature", resourceId: source.row.id, after: { signatureId: source.row.signatureId, webhookId: source.row.id, failureCode: "SIGNATURE_CONTRACT_UNCONFIRMED" }, requestId: deps.requestId ?? randomUUID(), occurredAt: await source.repository.clock() }); });
    throw new DocumentConflictError();
  }
}
