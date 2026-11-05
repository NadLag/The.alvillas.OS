import type { TenantTransaction } from "@/platform/db/tenant";
import { externalPaymentSourceSchema, ExternalPaymentIntentError } from "../domain/external-payment-intent";
import { PaymentMethodAccessError } from "../domain/payment-method";
import type { ExternalPaymentRepository } from "../infrastructure/external-payment-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeSettlementFundingChecks } from "./employee-compensation-settlement";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { originalExternalPaymentActor, originalExternalPaymentIntent } from "./external-payment-service";

export type ExternalPaymentRequest = NonNullable<Awaited<ReturnType<ExternalPaymentRepository["find"]>>>;
export async function authorizeExternalPaymentSource(ctx: FinanceActorContext, tx: TenantTransaction, request: ExternalPaymentRequest, admission = false) {
  if (ctx.actorId !== request.requestedBy || ctx.organizationId !== request.organizationId) throw new PaymentMethodAccessError();
  const parsed = externalPaymentSourceSchema.safeParse(request.sourceSnapshot), saved = originalExternalPaymentIntent(request);
  if (!parsed.success) throw new ExternalPaymentIntentError(); const source = parsed.data;
  if (source.organizationId !== ctx.organizationId || source.userAccountId !== ctx.actorId || source.reservationId !== saved.input.receipt.reservationId || source.accountId !== saved.input.receipt.accountId || source.amount.amount !== saved.capture.amount || source.amount.currency !== saved.capture.currency) throw new ExternalPaymentIntentError();
  const finance = new FinanceRepository(tx, ctx.organizationId), now = await finance.clock(), account = await finance.findLedgerAccountById(source.accountId);
  if (!account) throw new ExternalPaymentIntentError();
  const resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: request.id, financialRecordId: request.id,
    propertyId: source.propertyId, reservationId: source.reservationId, guestId: source.guestId, city: source.city, region: source.region,
    assignedUserAccountId: source.userAccountId, assignedPersonId: source.personId, amount: source.amount.amount, occurredAt: source.receivedAt, dataClass: "financial" as const },
    target = { ...resource, id: undefined, financialRecordId: undefined, occurredAt: now },
    checks = [{ action: "view" as const, resource }, ...employeeSettlementFundingChecks(ctx, account, source.amount.amount, new Date(source.receivedAt), "view"),
      ...admission ? [{ action: "create" as const, resource: target }, { action: "pay" as const, resource: target }, ...employeeSettlementFundingChecks(ctx, account, source.amount.amount, now, "pay")] : []];
  await recheckFinanceAuthorization(ctx, tx, now, checks, new PaymentMethodAccessError());
  await recheckFinanceAuthorization(originalExternalPaymentActor(request), tx, now, checks, new PaymentMethodAccessError());
  return { source, resource, account, now };
}
