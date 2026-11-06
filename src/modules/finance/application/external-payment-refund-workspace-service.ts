import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { externalRefundIdentityInput, externalRefundRecoveryInput, externalRefundReviewInput, externalRefundReconciliationInput } from "../domain/external-payment-refund-command";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { externalPaymentContext } from "./external-payment-service";
import { externalPaymentRefundRequested } from "./external-payment-refund-service";
import { retainedExternalRefund, authorizeExternalRefundSourceView } from "./external-payment-refund-access";
import { inspectGuestDepositRefundInTransaction, presentGuestDepositResult } from "./guest-deposit-service";
import { admittedExternalRefundSettlement } from "./external-payment-refund-history";
import type { FinanceActorContext } from "./finance-access";
import type { z } from "zod";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
async function review(ctx: FinanceActorContext, input: z.infer<typeof externalRefundReviewInput>, tx: TenantTransaction) {
  const capture = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).capture(input.captureId), p = await inspectGuestDepositRefundInTransaction(ctx, input.refund, tx);
  if (!capture?.capturedAt || capture.intent.idempotencyKey !== input.refund.depositId || capture.intent.accountId !== input.refund.accountId || capture.currency !== input.refund.currency || p.snapshot.operation !== "RECEIPT" || p.snapshot.input.method !== input.refund.method) throw new ExternalPaymentRefundError();
  return { prepared: p, value: presentGuestDepositResult(ctx, p.resource, { captureId: capture.id, depositId: input.refund.depositId, amount: p.amount.toJSON(),
    account: { id: p.location.id, name: p.location.name }, reviewFingerprint: p.fingerprint }, p.now) };
}
export async function reviewExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundReviewInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const before = await review(ctx, input, tx);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_reviewed", resourceType: "financial_transaction", resourceId: input.refund.depositId,
      after: { captureId: input.captureId, reviewFingerprint: before.value.reviewFingerprint }, reason: "Reviewed original guest funds and actual merchant refund source", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await before.prepared.finance.clock() });
    const after = await review(ctx, input, tx); if (commandFingerprint(before.value) !== commandFingerprint(after.value)) throw new ExternalPaymentRefundError(); return after.value;
  });
}
async function read(ctx: FinanceActorContext, tx: TenantTransaction, request: Request, deps: Deps) {
  const saved = retainedExternalRefund(request, ctx), journal = await new GuestDepositRepository(tx, ctx.organizationId).byCommand(request.idempotencyKey);
  await authorizeExternalRefundSourceView(ctx, tx, request, journal ?? undefined);
  const observation = request.identity?.observations[0], settlement = providerRefundSettlementSchema.safeParse(observation?.settlement?.settlement),
    admittedSettlement = journal ? await admittedExternalRefundSettlement(new ExternalPaymentRefundRepository(tx, ctx.organizationId), request, journal) : null;
  const cancellation = await new GuestDepositRepository(tx, ctx.organizationId).externalRefundCancellation(request.id), first = request.identity ? await new GuestDepositRepository(tx, ctx.organizationId).firstCompletedExternalRefund(request.identity.id) : null;
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_viewed", resourceType: "financial_transaction", resourceId: request.id,
    after: { intentId: request.id }, reason: "Viewed original refund intent, provider confirmation and independent native admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
  await authorizeExternalRefundSourceView(ctx, tx, request, journal ?? undefined);
  return { id: request.id, idempotencyKey: request.idempotencyKey, captureId: request.captureId, depositId: request.depositId, idempotent: true,
    amount: Money.of(request.amount.toString(), request.currency).toJSON(), state: journal ? "COMPLETED" : cancellation ? "RELEASED" : observation?.state ?? (request.attempt ? "UNCONFIRMED" : "QUEUED"),
    refundId: request.identity?.refundId ?? null, refundedAt: journal ? journal.occurredAt.toISOString() : observation?.state === "COMPLETED" ? first?.refundedAt?.toISOString() ?? null : null,
    providerObservation: observation ? { state: observation.state, updatedAt: observation.providerUpdatedAt.toISOString() } : null,
    cancellation: cancellation ? { actorId: cancellation.actorId, reason: cancellation.reason, occurredAt: cancellation.occurredAt.toISOString() } : null,
    input: saved.input, settlement: journal ? admittedSettlement : settlement.success ? settlement.data : null, admission: journal ? { state: "ADMITTED" as const, transactionId: journal.id, occurredAt: journal.occurredAt.toISOString() } : null };
}
export async function getExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundIdentityInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => { const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).find(input.intentId); if (!request) throw new ExternalPaymentRefundError(); return read(ctx, tx, request, deps); });
}
export async function recoverExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundRecoveryInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => { const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).byKey(input.key); return { request: request ? await read(ctx, tx, request, deps) : null }; });
}
/** Queue read-only reconciliation of the original refund; this operation never authorizes another POST. */
export async function reconcileExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundReconciliationInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), hint = await repository.find(input.intentId); if (!hint) throw new ExternalPaymentRefundError();
    retainedExternalRefund(hint, ctx); await new GuestDepositRepository(tx, ctx.organizationId).lockSource(hint.depositId);
    const request = await repository.find(hint.id); if (!request?.attempt) throw new ExternalPaymentRefundError();
    await authorizeExternalRefundSourceView(ctx, tx, request);
    const refundId = input.refundId ?? request.identity?.refundId;
    if (!refundId || request.identity && request.identity.refundId !== refundId) throw new ExternalPaymentRefundError();
    const outbox = new OutboxRepository(tx, ctx.organizationId), now = await new FinanceRepository(tx, ctx.organizationId).clock(), nonce = crypto.randomUUID();
    await outbox.append(externalPaymentRefundRequested, { intentId: request.id, refundId }, "external-payment-refund:" + request.id + ":reconcile:" + nonce, now); await outbox.requestDispatch("external-payment-refund:" + request.id + ":reconcile-dispatch:" + nonce);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_reconciliation_requested", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, refundId }, reason: "Requested read-only verification of the original uncertain refund identity", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await authorizeExternalRefundSourceView(ctx, tx, request); await repository.flushGuards(); return { id: request.id, refundId, queued: true };
  });
}
