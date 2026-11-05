import type { TenantTransaction } from "@/platform/db/tenant";
import type { FinanceActorContext } from "./finance-access";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";

declare const authority: unique symbol;
/** Process-local authority cannot be supplied by a serialized command or reused in another transaction. */
export type ExternalRefundSupervisionAuthority = { readonly [authority]: true };
type Details = { tx: TenantTransaction; organizationId: string; actorId: string; intentId: string; heldContext: FinanceActorContext;
  afterWritten?: (journal: { id: string; occurredAt: Date }) => Promise<void> };
const issued = new WeakMap<ExternalRefundSupervisionAuthority, Details>();
export function issueExternalRefundSupervisionAuthority(details: Details): ExternalRefundSupervisionAuthority {
  const token = Object.freeze({}) as ExternalRefundSupervisionAuthority; issued.set(token, details); return token;
}
export function externalRefundSupervisionAuthorityDetails(token: ExternalRefundSupervisionAuthority, ctx: FinanceActorContext, tx: TenantTransaction, intentId: string) {
  const details = issued.get(token);
  if (!details || details.tx !== tx || details.organizationId !== ctx.organizationId || details.actorId !== ctx.actorId || details.intentId !== intentId ||
    details.heldContext.organizationId !== ctx.organizationId || details.heldContext.actorId !== ctx.actorId || details.heldContext.authContext.userAccountId !== ctx.actorId) throw new ExternalPaymentRefundError();
  return details;
}
