import type { TenantTransaction } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { assertExternalPaymentRefund, ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import type { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { readGuestDepositSourceInTransaction } from "./guest-deposit-service";
import { employeeSettlementFundingChecks } from "./employee-compensation-settlement";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { externalRefundSupervisionAuthorityDetails, type ExternalRefundSupervisionAuthority } from "./external-refund-supervision-authority";

type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
export function retainedExternalRefund(request: Request, ctx: FinanceActorContext) {
  const saved = assertExternalPaymentRefund(request);
  if (ctx.actorId !== request.requestedBy || ctx.organizationId !== request.organizationId) throw new ExternalPaymentRefundError();
  return saved;
}
export function externalRefundAuthorityContexts(ctx: FinanceActorContext, tx: TenantTransaction, request: Request, supervision?: ExternalRefundSupervisionAuthority) {
  const independent = supervision ? externalRefundSupervisionAuthorityDetails(supervision, ctx, tx, request.id) : null,
    saved = independent ? assertExternalPaymentRefund(request) : retainedExternalRefund(request, ctx);
  return { saved, contexts: [ctx, independent?.heldContext ?? { ...ctx, authContext: restoreAuthorizationCap(request.authorizationCap) }] };
}
export async function authorizeExternalRefundSourceView(ctx: FinanceActorContext, tx: TenantTransaction, request: Request, journal?: { id: string; occurredAt: Date }, supervision?: ExternalRefundSupervisionAuthority) {
  const { saved, contexts } = externalRefundAuthorityContexts(ctx, tx, request, supervision);
  const first = request.identity ? await new GuestDepositRepository(tx, ctx.organizationId).firstCompletedExternalRefund(request.identity.id) : null;
  for (const actor of contexts) {
    const source = await readGuestDepositSourceInTransaction(actor, saved.input.refund.depositId, tx);
    if (source.location.id !== saved.input.refund.accountId) throw new ExternalPaymentRefundError();
    const at = journal?.occurredAt ?? first?.refundedAt ?? request.identity?.observations[0]?.refundedAt ?? request.requestedAt, target = { ...source.resource, id: journal?.id ?? request.id, financialRecordId: journal?.id ?? request.id, occurredAt: at, amount: saved.input.refund.amount };
    await recheckFinanceAuthorization(actor, tx, await source.finance.clock(), [{ action: "view", resource: target }, ...employeeSettlementFundingChecks(actor, source.location, saved.input.refund.amount, at, "view")], new ExternalPaymentRefundError());
  }
}
