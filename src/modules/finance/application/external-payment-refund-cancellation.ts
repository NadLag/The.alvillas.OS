import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner, type TenantTransaction } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { externalRefundCancellationInput } from "../domain/external-payment-refund-command";
import { externalPaymentContext } from "./external-payment-service";
import { retainedExternalRefund, authorizeExternalRefundSourceView } from "./external-payment-refund-admission";
import { readGuestDepositSourceInTransaction } from "./guest-deposit-service";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { employeeSettlementFundingChecks } from "./employee-compensation-settlement";

type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
async function cancellationAuthority(ctx: FinanceActorContext, tx: TenantTransaction, request: Request) {
  await authorizeExternalRefundSourceView(ctx, tx, request);
  for (const actor of [ctx, { ...ctx, authContext: restoreAuthorizationCap(request.authorizationCap) }]) {
    const source = await readGuestDepositSourceInTransaction(actor, request.depositId, tx), now = await source.finance.clock(), amount = Money.of(request.amount.toString(), request.currency).toJSON().amount;
    for (const occurredAt of [request.requestedAt, now]) {
      const resource = { ...source.resource, id: request.id, financialRecordId: request.id, assignedUserAccountId: request.requestedBy, amount, occurredAt };
      await recheckFinanceAuthorization(actor, tx, now, [{ action: "view", resource }, { action: "void", resource }, ...employeeSettlementFundingChecks(actor, source.location, amount, occurredAt, "void")], new ExternalPaymentRefundError());
    }
  }
}
/** Release only a durable promise which demonstrably never reached a provider attempt. */
export async function cancelUnattemptedExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundCancellationInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), native = new GuestDepositRepository(tx, ctx.organizationId), hint = await repository.find(input.intentId);
    if (!hint) throw new ExternalPaymentRefundError(); retainedExternalRefund(hint, ctx); await native.lockSource(hint.depositId);
    const request = await repository.find(hint.id); if (!request) throw new ExternalPaymentRefundError(); retainedExternalRefund(request, ctx);
    const existing = await repository.cancellation(request.id);
    if (existing) {
      if (existing.actorId !== ctx.actorId || existing.reason !== input.reason) throw new ExternalPaymentRefundError();
      await authorizeExternalRefundSourceView(ctx, tx, request); return { id: request.id, idempotent: true };
    }
    if (request.attempt || request.identity || await native.byCommand(request.idempotencyKey)) throw new ExternalPaymentRefundError();
    await cancellationAuthority(ctx, tx, request);
    const source = await readGuestDepositSourceInTransaction(ctx, request.depositId, tx);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_cancelled_before_attempt", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, captureId: request.captureId, depositId: request.depositId, idempotencyKey: request.idempotencyKey, amount: Money.of(request.amount.toString(), request.currency).toJSON(), disposition: "CANCELLED_BEFORE_PROVIDER_ATTEMPT" },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await source.finance.clock() });
    const witness = await repository.cancellation(request.id);
    if (!witness || witness.actorId !== ctx.actorId || witness.reason !== input.reason) throw new ExternalPaymentRefundError();
    await cancellationAuthority(ctx, tx, request); await repository.flushGuards(); return { id: request.id, idempotent: false };
  });
}
