import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { randomUUID } from "node:crypto";
import { DocumentAccessError, DocumentConflictError, DocumentRateLimitError } from "../domain/document-command";
import { SignatureIdentityRecoveryRepository } from "../infrastructure/signature-identity-recovery-repository";
import { documentActorContext, type DocumentActorContext } from "./document-archive";
import { originalSignatureIdentityRecovery, signatureIdentityRecoveryResult, signatureIdentityRecoveryOutboxKey } from "./document-signature-identity-recovery";
import { nativeSignatureIdentityRecoveryContext, type SignatureIdentityRecoveryDependencies } from "./document-signature-identity-context";
import { executeSignatureIdentityRecoveryReference } from "./document-signature-identity-worker";

const inputSchema = z.object({ recoveryId: z.uuid() }).strict();
export async function reconcileSignatureIdentityRecovery(actor: DocumentActorContext, raw: unknown, deps: SignatureIdentityRecoveryDependencies) {
  const ctx = documentActorContext(actor), input = inputSchema.parse(raw), captured = await withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignatureIdentityRecoveryRepository(tx, ctx.organizationId), row = await repository.identityRecovery(input.recoveryId); if (!row) throw new DocumentAccessError(); await signatureIdentityRecoveryResult(ctx, tx, row, deps); const event = await new OutboxRepository(tx, ctx.organizationId).byIdempotencyKey(signatureIdentityRecoveryOutboxKey(ctx.actorId, row.commandKey)); if (!event) throw new DocumentConflictError();
    const current = await nativeSignatureIdentityRecoveryContext(ctx, tx, originalSignatureIdentityRecovery(row).snapshot.command, deps), budget = current.current.current.archive.policy.value.upload_admission, rate = await consumeRateLimit(tx, ctx.organizationId, { key: "document-signature-identity-reconcile:" + ctx.actorId, limit: budget.max_requests, windowSeconds: budget.window_seconds, now: current.current.current.archive.now }); return { event, rate }; });
  if (!captured.rate.allowed) throw new DocumentRateLimitError(captured.rate.resetAt);
  await executeSignatureIdentityRecoveryReference({ organizationId: ctx.organizationId, outboxEventId: captured.event.id }, deps);
  return withTenant(deps.db, ctx.organizationId, async tx => { const repository = new SignatureIdentityRecoveryRepository(tx, ctx.organizationId), row = await repository.identityRecovery(input.recoveryId); if (!row) throw new DocumentAccessError(); const result = await signatureIdentityRecoveryResult(ctx, tx, row, deps);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "documents.signature.identity_reconciled", resourceType: "signature", resourceId: row.signatureId, after: { signatureId: row.signatureId, recoveryId: row.id, state: result.state }, requestId: deps.requestId ?? randomUUID(), occurredAt: await repository.clock() }); return signatureIdentityRecoveryResult(ctx, tx, row, deps); });
}
