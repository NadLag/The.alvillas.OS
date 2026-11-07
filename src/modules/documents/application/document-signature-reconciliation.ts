import { randomUUID } from "node:crypto";
import { withTenant } from "@/platform/db/tenant";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { DocumentAccessError, DocumentConflictError, DocumentRateLimitError } from "../domain/document-command";
import { signatureDistributionReconcileInput, signatureDistributionReconciliationSchema, signatureDistributionRequested } from "../domain/document-signature-distribution";
import { SignaturePreparationRepository } from "../infrastructure/signature-preparation-repository";
import { documentActorContext, type DocumentActorContext } from "./document-archive";
import { nativeSignatureDistributionContext } from "./document-signature-distribution-context";
import { originalSignatureDistribution, signatureDistributionOutboxKey, type SignatureDistributionDependencies } from "./document-signature-distribution";
import { executeSignatureDistributionReference } from "./document-signature-distribution-worker";

type Dependencies = SignatureDistributionDependencies & Pick<NonNullable<Parameters<typeof executeSignatureDistributionReference>[1]>, "provider" | "providerOrigin">;
/** Explicit read-only reconciliation cannot admit or repeat an external send. */
export async function reconcileSignatureDistribution(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx = documentActorContext(actor), input = signatureDistributionReconcileInput.parse(raw);
  const captured = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new SignaturePreparationRepository(tx, ctx.organizationId), row = await repository.distribution(input.distributionId); if (!row) throw new DocumentAccessError();
    const { snapshot } = originalSignatureDistribution(row), current = await nativeSignatureDistributionContext(ctx, tx, snapshot.preparation.intentId, deps.env), attempt = await repository.distributionAttempt(row.signatureId),
      event = await new OutboxRepository(tx, ctx.organizationId).byIdempotencyKey(signatureDistributionOutboxKey(row.requestedBy, row.commandKey));
    if (!event || event.type !== signatureDistributionRequested || event.occurredAt.getTime() !== row.requestedAt.getTime()) throw new DocumentConflictError();
    const budget = current.current.archive.policy.value.upload_admission, rate = await consumeRateLimit(tx, ctx.organizationId, { key: "document-signature-reconcile:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.current.archive.now });
    return { row, snapshot, current, attempt, event, rate };
  });
  if (!captured.rate.allowed) throw new DocumentRateLimitError(captured.rate.resetAt);
  const outcome = !captured.attempt ? { state: "ADMITTED" as const } : captured.attempt.intentId !== captured.row.id ? { state: "SUPERSEDED" as const } : await executeSignatureDistributionReference({ organizationId: ctx.organizationId, outboxEventId: captured.event.id }, { ...deps, reconcileActor: ctx });
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await nativeSignatureDistributionContext(ctx, tx, captured.snapshot.preparation.intentId, deps.env); if (current.fingerprint !== captured.current.fingerprint) throw new DocumentConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.distribution_reconciled", resourceType: "signature", resourceId: captured.row.signatureId,
      after: { signatureId: captured.row.signatureId, intentId: captured.row.id, state: outcome.state }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.current.archive.now });
    const final = await nativeSignatureDistributionContext(ctx, tx, captured.snapshot.preparation.intentId, deps.env); if (final.fingerprint !== current.fingerprint) throw new DocumentConflictError();
    return signatureDistributionReconciliationSchema.parse({ id: captured.row.id, signatureId: captured.row.signatureId, preparationId: captured.snapshot.preparation.intentId, state: outcome.state });
  });
}
