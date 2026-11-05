import { prisma } from "@/platform/db/client";
import { isDeepStrictEqual } from "node:util";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import type { Prisma } from "@prisma/client";
import { Money } from "@/platform/money/money";
import { ExternalPaymentRefundError, verifiedExternalPaymentRefund } from "../domain/external-payment-refund-intent";
import { externalRefundSupervisionReviewInput } from "../domain/external-payment-refund-supervision";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { readGuestDepositSourceInTransaction, presentGuestDepositResult } from "./guest-deposit-service";
import { externalPaymentContext } from "./external-payment-service";
import { employeeSettlementFundingChecks } from "./employee-compensation-settlement";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
/** Explicit financial override and reconciliation grants do not inherit the original requester's data access. */
export async function inspectExternalRefundForSupervision(ctx: FinanceActorContext, tx: TenantTransaction, request: Request) {
  if (ctx.organizationId !== request.organizationId || ctx.actorId !== ctx.authContext.userAccountId || ctx.organizationId !== ctx.authContext.organizationId) throw new ExternalPaymentRefundError();
  const verified = verifiedExternalPaymentRefund(request), native = new GuestDepositRepository(tx, ctx.organizationId), source = await readGuestDepositSourceInTransaction(ctx, request.depositId, tx),
    first = request.identity ? await native.firstCompletedExternalRefund(request.identity.id) : null;
  if (!first?.refundedAt || await native.externalRefundCancellation(request.id) || await native.byCommand(request.idempotencyKey) ||
    source.location.id !== verified.saved.input.refund.accountId || source.snapshot.operation !== "RECEIPT" || source.snapshot.input.method !== verified.saved.input.refund.method || source.amount.currency !== request.currency) throw new ExternalPaymentRefundError();
  const amount = Money.of(request.amount.toString(), request.currency), reserved = Money.of(await native.reservedExternalRefunds(request.depositId), request.currency);
  if (!amount.amount.gt(0) || source.outstanding.subtract(reserved).add(amount).amount.lt(amount.amount)) throw new ExternalPaymentRefundError();
  const target = { ...source.resource, id: request.id, financialRecordId: request.id, occurredAt: first.refundedAt, amount: amount.toJSON().amount }, now = await source.finance.clock();
  await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: target }, { action: "override", resource: target }, { action: "reconcile", resource: target },
    ...employeeSettlementFundingChecks(ctx, source.location, amount.toJSON().amount, first.refundedAt, "view")], new ExternalPaymentRefundError());
  const basis = { intentId: request.id, originalRequestedBy: request.requestedBy, prospectiveAdmitter: ctx.actorId, captureId: request.captureId, depositId: request.depositId,
    originalRequestFingerprint: request.requestFingerprint, originalRequestKey: request.idempotencyKey, refundId: request.identity!.refundId,
    firstEvidenceId: first.id, firstRefundedAt: first.refundedAt.toISOString(), latestEvidenceId: verified.observation.id, settlementId: verified.observation.settlement!.id,
    settlement: verified.settlement, originalTransactionId: source.row.id, originalSource: source.snapshot.source, currentSourceScope: source.resource,
    sourceMovementsFingerprint: source.movements.fingerprint, outstanding: source.outstanding.toJSON(), reserved: reserved.toJSON() };
  return { verified, source, target, now, basis, fingerprint: commandFingerprint(basis), refundedAt: first.refundedAt };
}

/** Retain a reasoned financial review; it neither delegates a payment nor creates a ledger movement. */
export async function reviewExternalPaymentRefundSupervision(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundSupervisionReviewInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), request = await repository.find(input.intentId);
    if (!request) throw new ExternalPaymentRefundError();
    const source = await inspectExternalRefundForSupervision(ctx, tx, request), reviewId = crypto.randomUUID(), fingerprint = commandFingerprint({ source: source.fingerprint, reason: input.reason });
    const after = JSON.parse(JSON.stringify({ reviewId, intentId: request.id, reviewFingerprint: fingerprint, reason: input.reason, basis: source.basis, authorizationCap: captureAuthorizationCap(ctx.authContext) })) as Prisma.InputJsonObject;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_supervision_reviewed", resourceType: "financial_transaction", resourceId: request.id,
      propertyScopeId: source.target.propertyId, after, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await source.source.finance.clock() });
    const witness = await repository.supervisionReview(reviewId, ctx.actorId);
    if (!witness || witness.resourceId !== request.id || witness.reason !== input.reason || !isDeepStrictEqual(witness.after, after)) throw new ExternalPaymentRefundError();
    const current = await repository.find(request.id); if (!current || (await inspectExternalRefundForSupervision(ctx, tx, current)).fingerprint !== source.fingerprint) throw new ExternalPaymentRefundError();
    return presentGuestDepositResult(ctx, source.target, { reviewId, intentId: request.id, originalRequestedBy: request.requestedBy, prospectiveAdmitter: ctx.actorId,
      amount: Money.of(request.amount.toString(), request.currency).toJSON(), refundedAt: source.refundedAt.toISOString(), settlement: source.verified.settlement, reason: input.reason, reviewFingerprint: fingerprint }, await source.source.finance.clock());
  });
}
