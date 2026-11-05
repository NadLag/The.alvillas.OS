import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { PayPalPaymentProvider } from "@/platform/providers/real";
import { Money } from "@/platform/money/money";
import { retainExternalPaymentIntent, assertExternalPaymentIntent, ExternalPaymentIntentError } from "../domain/external-payment-intent";
import { guestDepositReviewInput } from "../domain/guest-deposit-command";
import { PaymentMethodAccessError, PaymentMethodChangedError, configuredPaymentMethod } from "../domain/payment-method";
import { ExternalPaymentRepository } from "../infrastructure/external-payment-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { PaymentMethodRepository } from "../infrastructure/payment-method-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { guestPaymentMethodScopes } from "./guest-deposit-payment-method";
import { inspectGuestDepositReceiptInTransaction } from "./guest-deposit-service";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { assertExternalPaymentLocation } from "./external-payment-location";
import { providerCaptureSettlementSchema } from "@/platform/providers/payment-capture";

export const externalPaymentCaptureRequested = "ExternalPaymentCaptureRequested";
const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict();
const payloadSchema = z.object({ intentId: z.uuid() }).strict();
const paymentId = z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u);
type Gateway = Pick<PayPalPaymentProvider, "capture" | "lookup">;
type Deps = { db?: TenantTransactionRunner; requestId?: string; provider?: Gateway };
type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRepository["find"]>>>;
const key = (id: string) => "external-payment-intent:" + id + ":capture";
function context(input: FinanceActorContext) {
  const cap = captureAuthorizationCap(input.authContext);
  if (cap.organizationId !== input.organizationId || cap.userAccountId !== input.actorId) throw new PaymentMethodAccessError();
  return { ...input, authContext: restoreAuthorizationCap(cap) };
}
function original(request: Request) {
  const saved = retainExternalPaymentIntent(request.input, request.organizationId, request.requestedBy);
  if (saved.fingerprint !== request.requestFingerprint || saved.sourceIdentity !== request.sourceIdentity || saved.idempotencyKey !== request.idempotencyKey) throw new ExternalPaymentIntentError();
  return saved;
}
function actor(request: Request): FinanceActorContext {
  const authContext = restoreAuthorizationCap(request.authorizationCap);
  if (authContext.organizationId !== request.organizationId || authContext.userAccountId !== request.requestedBy) throw new PaymentMethodAccessError();
  return { organizationId: request.organizationId, actorId: request.requestedBy, authContext };
}
function view(request: Pick<Request, "id" | "idempotencyKey" | "orderId" | "amount" | "currency" | "capture">, idempotent: boolean) {
  const settlement = providerCaptureSettlementSchema.safeParse(request.capture?.settlement);
  return { id: request.id, idempotencyKey: request.idempotencyKey, orderId: request.orderId, amount: Money.of(request.amount.toString(), request.currency).toJSON(),
    state: request.capture ? "CAPTURED" as const : "PENDING" as const, captureId: request.capture?.id ?? null, capturedAt: request.capture?.capturedAt?.toISOString() ?? null, observedAt: request.capture?.observedAt.toISOString() ?? null, settlement: settlement.success ? settlement.data : null, idempotent };
}
export { context as externalPaymentContext, original as originalExternalPaymentIntent, actor as originalExternalPaymentActor, view as externalPaymentIntentView };
async function prepare(ctx: FinanceActorContext, saved: ReturnType<typeof retainExternalPaymentIntent>, tx: TenantTransaction) {
  const draft = guestDepositReviewInput.strip().parse(saved.input.receipt), prepared = await inspectGuestDepositReceiptInTransaction(ctx, draft, tx);
  const catalog = await new PaymentMethodRepository(tx, ctx.organizationId).catalog({ at: await prepared.finance.clock(), currency: draft.currency,
    scopes: await guestPaymentMethodScopes(tx, ctx.organizationId, draft.reservationId, await prepared.finance.clock()) });
  if (configuredPaymentMethod(catalog.policy, draft.method, prepared.amount).adapter !== "paypal" || saved.input.receipt.reviewFingerprint !== prepared.fingerprint || saved.input.receipt.paymentMethodFingerprint !== catalog.identity) throw new PaymentMethodChangedError();
  assertExternalPaymentLocation(configuredPaymentMethod(catalog.policy, draft.method, prepared.amount), prepared.location);
  await recheckFinanceAuthorization(ctx, tx, await prepared.finance.clock(), [{ action: "pay", resource: prepared.resource }], new PaymentMethodAccessError());
  return { prepared, catalog };
}
export async function requestExternalPaymentCapture(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = context(inputContext), saved = retainExternalPaymentIntent(raw, ctx.organizationId, ctx.actorId), cap = captureAuthorizationCap(ctx.authContext);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRepository(tx, ctx.organizationId);
    await new GuestDepositRepository(tx, ctx.organizationId).lockCommand(saved.idempotencyKey); await repository.lock(saved.idempotencyKey);
    const existing = await repository.byKey(saved.idempotencyKey);
    if (existing) {
      if (existing.requestedBy !== ctx.actorId) throw new PaymentMethodAccessError();
      assertExternalPaymentIntent(original(existing), raw, ctx.organizationId, ctx.actorId);
      await prepare(ctx, saved, tx); return view(existing, true);
    }
    if (await new GuestDepositRepository(tx, ctx.organizationId).byCommand(saved.idempotencyKey)) throw new ExternalPaymentIntentError();
    const before = await prepare(ctx, saved, tx), sourceSnapshot = await repository.sourceSnapshot(saved, cap.personId),
      request = await repository.create(saved, cap, { id: before.catalog.rule.id, version: before.catalog.rule.version }, sourceSnapshot);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.requested", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, sourceIdentity: saved.sourceIdentity, requestFingerprint: saved.fingerprint, provider: saved.input.provider,
        policyId: request.policyId, policyVersion: request.policyVersion, amount: { amount: saved.capture.amount, currency: saved.capture.currency } }, reason: saved.input.receipt.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: request.requestedAt });
    const outbox = new OutboxRepository(tx, ctx.organizationId);
    await outbox.append(externalPaymentCaptureRequested, { intentId: request.id }, key(request.id), request.requestedAt); await outbox.requestDispatch("external-payment:" + request.id + ":dispatch");
    const after = await prepare(ctx, saved, tx);
    if (before.catalog.identity !== after.catalog.identity || commandFingerprint(before.prepared.source) !== commandFingerprint(after.prepared.source)) throw new PaymentMethodChangedError();
    await repository.flushGuards(); return view({ ...request, capture: null }, false);
  });
}
async function referenced(tx: TenantTransaction, reference: z.infer<typeof referenceSchema>) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId), payload = payloadSchema.safeParse(event?.payload);
  if (!event || event.type !== externalPaymentCaptureRequested || !payload.success) throw new ExternalPaymentIntentError();
  const repository = new ExternalPaymentRepository(tx, reference.organizationId); await repository.lock(payload.data.intentId);
  const request = await repository.find(payload.data.intentId);
  if (!request || event.idempotencyKey !== key(request.id) && !new RegExp("^external-payment-intent:" + request.id + ":resume:[a-f0-9-]{36}$", "u").test(event.idempotencyKey)) throw new ExternalPaymentIntentError();
  return { request, repository };
}
/** Both database phases finish before provider I/O; capture evidence commits independently of financial admission. */
export async function executeExternalPaymentCaptureReference(raw: unknown, deps: Deps = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma;
  const admitted = await withTenant(db, reference.organizationId, async tx => {
    const { request, repository } = await referenced(tx, reference), saved = original(request);
    if (request.capture) return { complete: view(request, true), saved, requestId: request.id };
    if (!request.attempt) {
      await prepare(actor(request), saved, tx); const attempt = await repository.attempt(request.id);
      await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.capture_started", resourceType: "financial_transaction", resourceId: request.id,
        after: { intentId: request.id, attemptId: attempt.id }, reason: "Retained the authorized original provider attempt before external I/O", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: attempt.startedAt });
      await prepare(actor(request), saved, tx); await repository.flushGuards();
    }
    return { complete: null, saved, requestId: request.id };
  });
  if (admitted.complete) return admitted.complete;
  const provider = deps.provider ?? new PayPalPaymentProvider(), state = await provider.lookup(admitted.saved.capture);
  if (state.state === "WAITING") throw new ExternalPaymentIntentError();
  if (state.state === "APPROVED") await withTenant(db, reference.organizationId, async tx => {
    const { request } = await referenced(tx, reference); await prepare(actor(request), original(request), tx);
  });
  const verified = state.state === "CAPTURED" ? state : await provider.capture(admitted.saved.capture), capturedId = paymentId.parse(verified.paymentId), capturedAt = new Date(z.iso.datetime().parse(verified.capturedAt)).toISOString();
  return withTenant(db, reference.organizationId, async tx => {
    const { request, repository } = await referenced(tx, reference), saved = original(request);
    if (request.id !== admitted.requestId || saved.fingerprint !== admitted.saved.fingerprint) throw new ExternalPaymentIntentError();
    if (request.capture) { if (request.capture.paymentId !== capturedId || request.capture.capturedAt?.toISOString() !== capturedAt) throw new ExternalPaymentIntentError(); return view(request, true); }
    const evidence = { schemaVersion: 1 as const, provider: "paypal" as const, orderId: saved.input.orderId, paymentId: capturedId, amount: { amount: saved.capture.amount, currency: saved.capture.currency } }, capture = await repository.capture(request.id, evidence, capturedAt, verified.settlement);
    await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.captured", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: capture.id, evidence }, reason: "Verified the original provider capture without financial admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, reference.organizationId).clock() });
    await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.capture_time_retained", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: capture.id, capturedAt }, reason: "Retained the original provider capture time independently of reconciliation time", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, reference.organizationId).clock() });
    if (verified.settlement) await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.settlement_retained", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: capture.id, settlement: verified.settlement }, reason: "Retained actual gross, deductions and net merchant funds without guessing settlement", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, reference.organizationId).clock() });
    await repository.flushGuards(); return view({ ...request, capture }, false);
  });
}
/** Unknown provider outcomes remain reconcilable; failure is never evidence that no money was captured. */
export async function failExternalPaymentCaptureReference(raw: unknown, deps: Deps = {}) {
  const reference = referenceSchema.parse(raw);
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const { request, repository } = await referenced(tx, reference);
    if (!request.capture && !await repository.failure(request.id, reference.outboxEventId)) {
      await writeAuditEvent(tx, { organizationId: reference.organizationId, actorId: null, action: "finance.external_payment.capture_unconfirmed", resourceType: "financial_transaction", resourceId: request.id,
        after: { intentId: request.id, outboxEventId: reference.outboxEventId, failureCode: "CAPTURE_UNCONFIRMED" }, reason: "Retained an unconfirmed original provider outcome for source reconciliation", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, reference.organizationId).clock() });
    }
    return view(request, true);
  });
}
