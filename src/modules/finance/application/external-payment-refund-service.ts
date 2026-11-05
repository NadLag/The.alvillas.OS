import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { PayPalPaymentProvider } from "@/platform/providers/real";
import { paymentRefundIntent, providerRefundEvidenceSchema } from "@/platform/providers/payment-refund";
import { Money } from "@/platform/money/money";
import { retainExternalPaymentRefund, ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { guestDepositRefundReviewInput } from "../domain/guest-deposit-command";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { inspectGuestDepositRefundInTransaction } from "./guest-deposit-service";
import { externalPaymentContext } from "./external-payment-service";
import type { FinanceActorContext } from "./finance-access";

export const externalPaymentRefundRequested = "ExternalPaymentRefundRequested";
type Deps = { db?: TenantTransactionRunner; requestId?: string; provider?: Pick<PayPalPaymentProvider, "refund" | "lookupRefund"> };
type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict(), payloadSchema = z.object({ intentId: z.uuid() }).strict();
const key = (id: string) => "external-payment-refund:" + id + ":request";
function retained(request: Request) {
  const saved = retainExternalPaymentRefund(request.input, request.organizationId, request.requestedBy);
  if (saved.fingerprint !== request.requestFingerprint || saved.canonicalRequest !== request.canonicalRequest || saved.idempotencyKey !== request.idempotencyKey) throw new ExternalPaymentRefundError();
  return saved;
}
function originalActor(request: Request): FinanceActorContext {
  return externalPaymentContext({ organizationId: request.organizationId, actorId: request.requestedBy, authContext: restoreAuthorizationCap(request.authorizationCap) });
}
function view(request: Request, idempotent: boolean) {
  const observation = request.identity?.observations[0];
  return { id: request.id, idempotencyKey: request.idempotencyKey, amount: Money.of(request.amount.toString(), request.currency).toJSON(),
    state: observation?.state ?? (request.attempt ? "UNCONFIRMED" : "QUEUED"), refundId: request.identity?.refundId ?? null, refundedAt: observation?.refundedAt?.toISOString() ?? null, idempotent };
}
async function prepare(ctx: FinanceActorContext, saved: ReturnType<typeof retainExternalPaymentRefund>, tx: TenantTransaction, ownReservation = false) {
  const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), capture = await repository.capture(saved.input.captureId),
    prepared = await inspectGuestDepositRefundInTransaction(ctx, guestDepositRefundReviewInput.strip().parse(saved.input.refund), tx);
  if (!capture?.capturedAt || capture.intent.idempotencyKey !== saved.input.refund.depositId || capture.intent.accountId !== saved.input.refund.accountId ||
    capture.currency !== saved.input.refund.currency || capture.intent.input === null || prepared.snapshot.operation !== "RECEIPT" || prepared.snapshot.input.method !== saved.input.refund.method) throw new ExternalPaymentRefundError();
  const held = Money.of(await repository.reserved(saved.input.refund.depositId), saved.input.refund.currency), available = prepared.outstanding.subtract(held);
  if (available.amount.lt(0) || !ownReservation && prepared.amount.amount.gt(available.amount)) throw new ExternalPaymentRefundError();
  return { repository, prepared, capture, providerIntent: paymentRefundIntent({ captureId: capture.paymentId, requestId: saved.idempotencyKey, amount: saved.input.refund.amount, currency: saved.input.refund.currency }) };
}
export async function requestExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), saved = retainExternalPaymentRefund(raw, ctx.organizationId, ctx.actorId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const native = new GuestDepositRepository(tx, ctx.organizationId), repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId);
    await native.lockCommand(saved.idempotencyKey);
    const existing = await repository.byKey(saved.idempotencyKey);
    if (existing) { if (existing.requestedBy !== ctx.actorId || retained(existing).fingerprint !== saved.fingerprint) throw new ExternalPaymentRefundError(); await prepare(ctx, saved, tx, true); return view(existing, true); }
    if (await native.byCommand(saved.idempotencyKey)) throw new ExternalPaymentRefundError();
    const hint = await prepare(ctx, saved, tx); await hint.prepared.finance.lockReservationFinancialCorrection(hint.prepared.snapshot.source.reservationId); await native.lockSource(saved.input.refund.depositId);
    const before = await prepare(ctx, saved, tx); if (before.prepared.fingerprint !== saved.input.refund.reviewFingerprint) throw new ExternalPaymentRefundError();
    const request = await repository.create(saved, captureAuthorizationCap(ctx.authContext));
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_requested", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: request.captureId, depositId: request.depositId, requestFingerprint: saved.fingerprint, amount: before.prepared.amount.toJSON() }, reason: saved.input.refund.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: request.requestedAt });
    const outbox = new OutboxRepository(tx, ctx.organizationId); await outbox.append(externalPaymentRefundRequested, { intentId: request.id }, key(request.id), request.requestedAt); await outbox.requestDispatch("external-payment-refund:" + request.id + ":dispatch");
    await prepare(ctx, saved, tx, true); await repository.flushGuards(); return view(request, false);
  });
}
async function referenced(tx: TenantTransaction, reference: z.infer<typeof referenceSchema>) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload);
  if (!event || event.type !== externalPaymentRefundRequested || !payload.success) throw new ExternalPaymentRefundError();
  const repository = new ExternalPaymentRefundRepository(tx, reference.organizationId), request = await repository.find(payload.data.intentId);
  if (!request || event.idempotencyKey !== key(request.id)) throw new ExternalPaymentRefundError();
  await new GuestDepositRepository(tx, reference.organizationId).lockSource(request.depositId);
  return { repository, request: (await repository.find(request.id))! };
}
export async function executeExternalPaymentRefundReference(raw: unknown, deps: Deps = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, start = await withTenant(db, reference.organizationId, async tx => {
    const { repository, request } = await referenced(tx, reference), saved = retained(request), providerIntent = paymentRefundIntent({ captureId: request.capture.paymentId, requestId: request.idempotencyKey, amount: request.amount.toString(), currency: request.currency });
    if (request.identity) return { request, providerIntent, post: false, lookup: request.identity.refundId };
    if (request.attempt) return { request, providerIntent, post: false, lookup: null };
    await prepare(originalActor(request), saved, tx, true);
    const attempt = await repository.attempt(request.id);
    await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.refund_started", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, attemptId: attempt.id }, reason: "Committed the original reserved refund attempt before its single provider POST", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: attempt.startedAt });
    await prepare(originalActor(request), saved, tx, true); await repository.flushGuards();
    return { request, providerIntent, post: true, lookup: null };
  });
  if (!start.post && !start.lookup) return view(start.request, true);
  const provider = deps.provider ?? new PayPalPaymentProvider(), evidence = providerRefundEvidenceSchema.parse(start.lookup ? await provider.lookupRefund({ intent: start.providerIntent, refundId: start.lookup }) : await provider.refund(start.providerIntent));
  if (evidence.captureId !== start.providerIntent.captureId || evidence.requestId !== start.providerIntent.requestId || !Money.of(evidence.amount.amount, evidence.amount.currency).equals(Money.of(start.providerIntent.amount, start.providerIntent.currency))) throw new ExternalPaymentRefundError();
  return withTenant(db, reference.organizationId, async tx => {
    const { repository, request } = await referenced(tx, reference); if (request.id !== start.request.id || retained(request).fingerprint !== retained(start.request).fingerprint) throw new ExternalPaymentRefundError();
    const retainedEvidence = await repository.observe(request, evidence);
    if (!retainedEvidence.idempotent) await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.refund_observed", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, identityId: retainedEvidence.identity.id, evidenceId: retainedEvidence.observation.id, evidence }, reason: "Retained independently verified original provider refund without financial admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, reference.organizationId).clock() });
    await repository.flushGuards(); return view((await repository.find(request.id))!, retainedEvidence.idempotent);
  });
}
