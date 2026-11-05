import { authorize, type AuthContext, type Resource } from "./authorize";
import type { z } from "zod";
import type { externalPaymentSourceSchema } from "@/platform/ledger/external-payment-source";

export type ExternalPaymentFinancialSources = { original: Resource; capture?: Resource; funding: readonly Resource[]; fee?: Resource };
export function externalPaymentFinancialSources(id: string, source: z.infer<typeof externalPaymentSourceSchema>, capturedAt?: Date | null): ExternalPaymentFinancialSources {
  const original: Resource = { type: "financial_transaction", organizationId: source.organizationId, id, financialRecordId: id,
    propertyId: source.propertyId, reservationId: source.reservationId, city: source.city, region: source.region,
    assignedUserAccountId: source.userAccountId, assignedPersonId: source.personId, amount: source.amount.amount, occurredAt: source.receivedAt, dataClass: "financial" };
  const capture = capturedAt ? { ...original, occurredAt: capturedAt } : undefined;
  return { original, capture, funding: [original, ...capture ? [capture] : []].map(facts => ({ ...facts, id: source.accountId, financialRecordId: source.accountId })) };
}
/** History includes both the original request and the provider's economic date, plus independent physical custody. */
export function canReadExternalPayment(ctx: AuthContext, resource: Resource & { externalPayment?: ExternalPaymentFinancialSources }, action: "view" | "export", now: Date, requireFee = false) {
  const source = resource.externalPayment;
  if (!source || resource.organizationId !== ctx.organizationId || resource.type !== "financial_transaction" || !resource.id ||
      source.original.id !== resource.id || source.original.financialRecordId !== resource.id || !source.funding.length ||
      (source.capture && (source.capture.id !== resource.id || source.capture.financialRecordId !== resource.id))) return false;
  if (requireFee && (!source.fee || source.fee.organizationId !== ctx.organizationId || source.fee.type !== "expense" || !source.fee.id || !source.fee.amount ||
      !authorize(ctx, "view", source.fee, now) || action === "export" && !authorize(ctx, "export", source.fee, now))) return false;
  return [source.original, ...source.capture ? [source.capture] : [], ...source.funding].every(target =>
    target.organizationId === ctx.organizationId && target.type === "financial_transaction" && Boolean(target.id) && Boolean(target.amount) &&
    authorize(ctx, "view", target, now) && (action === "view" || authorize(ctx, "export", target, now)));
}
