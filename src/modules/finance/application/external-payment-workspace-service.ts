import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { ExternalPaymentRepository } from "../infrastructure/external-payment-repository";
import { PaymentMethodRepository } from "../infrastructure/payment-method-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { guestDepositReviewInput } from "../domain/guest-deposit-command";
import { ExternalPaymentIntentError } from "../domain/external-payment-intent";
import { configuredPaymentMethod, PaymentMethodAccessError, PaymentMethodChangedError } from "../domain/payment-method";
import { inspectGuestDepositReceiptInTransaction } from "./guest-deposit-service";
import { externalPaymentContext, externalPaymentIntentView, originalExternalPaymentIntent, externalPaymentCaptureRequested } from "./external-payment-service";
import { authorizeExternalPaymentSource, type ExternalPaymentRequest } from "./external-payment-access";
import { assertExternalPaymentLocation } from "./external-payment-location";
import { guestPaymentMethodScopes } from "./guest-deposit-payment-method";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
const identity = z.object({ id: z.uuid() }).strict();
export const externalPaymentReviewInput = z.object({ provider: z.literal("paypal"), orderId: z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u), receipt: guestDepositReviewInput }).strict();
async function review(ctx: FinanceActorContext, raw: z.infer<typeof externalPaymentReviewInput>, tx: Parameters<typeof inspectGuestDepositReceiptInTransaction>[2], retained?: ExternalPaymentRequest) {
  if (raw.receipt.externalReference !== raw.orderId) throw new ExternalPaymentIntentError();
  const prepared = await inspectGuestDepositReceiptInTransaction(ctx, raw.receipt, tx), now = await prepared.finance.clock(),
    catalog = retained ? await new PaymentMethodRepository(tx, ctx.organizationId).retainedCatalog({ ruleId: retained.policyId, version: retained.policyVersion,
      identity: originalExternalPaymentIntent(retained).input.receipt.paymentMethodFingerprint, currency: raw.receipt.currency }) : await new PaymentMethodRepository(tx, ctx.organizationId).catalog({ at: now, currency: raw.receipt.currency, scopes: await guestPaymentMethodScopes(tx, ctx.organizationId, raw.receipt.reservationId, now) }),
    method = configuredPaymentMethod(catalog.policy, raw.receipt.method, prepared.amount);
  if (method.adapter !== "paypal") throw new ExternalPaymentIntentError();
  assertExternalPaymentLocation(method, prepared.location);
  await recheckFinanceAuthorization(ctx, tx, now, [{ action: "pay", resource: prepared.resource }], new PaymentMethodAccessError());
  return { value: { reservationId: raw.receipt.reservationId, amount: prepared.amount.toJSON(), account: { id: prepared.location.id, name: prepared.location.name },
    method, receivedAt: raw.receipt.receivedAt, reviewFingerprint: prepared.fingerprint, paymentMethodFingerprint: catalog.identity }, resource: prepared.resource };
}
export async function reviewExternalPaymentIntent(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalPaymentReviewInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const before = await review(ctx, input, tx);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.reviewed", resourceType: "financial_transaction", resourceId: input.receipt.reservationId,
      after: { operation: "REVIEW_EXTERNAL_PAYMENT" }, reason: "Reviewed the original optional external payment source and exact Money", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    const after = await review(ctx, input, tx);
    if (commandFingerprint(before) !== commandFingerprint(after)) throw new PaymentMethodChangedError(); return before.value;
  });
}
export async function getExternalPaymentIntent(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = identity.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRepository(tx, ctx.organizationId).find(input.id); if (!request) throw new PaymentMethodAccessError();
    await authorizeExternalPaymentSource(ctx, tx, request);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.viewed", resourceType: "financial_transaction", resourceId: request.id,
      after: { operation: "VIEW_ORIGINAL_EXTERNAL_PAYMENT" }, reason: "Viewed the original retained payment intent and confirmation state", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await authorizeExternalPaymentSource(ctx, tx, request); return externalPaymentIntentView(request, true);
  });
}
export async function reviewCapturedPayPalAdmission(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = identity.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRepository(tx, ctx.organizationId).find(input.id); if (!request?.capture?.capturedAt) throw new ExternalPaymentIntentError();
    await authorizeExternalPaymentSource(ctx, tx, request, true); const saved = originalExternalPaymentIntent(request),
      receipt = guestDepositReviewInput.strip().parse({ ...saved.input.receipt, receivedAt: request.capture.capturedAt.toISOString() }),
      current = { provider: "paypal" as const, orderId: saved.input.orderId, receipt }, before = await review(ctx, current, tx, request);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.admission_reviewed", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: request.capture.id }, reason: "Reviewed confirmed original provider money before native financial admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await authorizeExternalPaymentSource(ctx, tx, request, true); const after = await review(ctx, current, tx, request);
    if (commandFingerprint(before) !== commandFingerprint(after)) throw new PaymentMethodChangedError();
    return { ...before.value, intentId: request.id, captureId: request.capture.id, purpose: receipt.purpose, orderId: request.orderId };
  });
}
export async function resumeExternalPaymentCapture(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = identity.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRepository(tx, ctx.organizationId); await repository.lock(input.id);
    const request = await repository.find(input.id); if (!request) throw new PaymentMethodAccessError();
    await authorizeExternalPaymentSource(ctx, tx, request, !request.capture); if (request.capture) return externalPaymentIntentView(request, true);
    const nonce = crypto.randomUUID(), outbox = new OutboxRepository(tx, ctx.organizationId), now = await new FinanceRepository(tx, ctx.organizationId).clock(),
      event = await outbox.append(externalPaymentCaptureRequested, { intentId: request.id }, "external-payment-intent:" + request.id + ":resume:" + nonce, now);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.reconciliation_requested", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, outboxEventId: event.id }, reason: "Requested reconciliation of the original external order before another idempotent capture attempt", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await outbox.requestDispatch("external-payment-resume:" + event.id); await authorizeExternalPaymentSource(ctx, tx, request, true); return externalPaymentIntentView(request, true);
  });
}
