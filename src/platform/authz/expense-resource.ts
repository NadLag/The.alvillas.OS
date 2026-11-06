import { authorize, type AuthContext, type Resource } from "./authorize";
import { calendarDateStart } from "@/platform/time/calendar";

export type ExpenseProperty = { id: string; cityId?: string | null; city?: string | null; regionId?: string | null; region?: string | null; timezone: string };
export type ExpenseFacts = { id: string; amount: string; reservationId?: string | null; state: string; occurredOn: Date; occurredAt?: Date; createdBy: string;
  externalPaymentFee?: { capture: { capturedAt: Date | null } } | null;
  externalPaymentRefundFeeCorrection?: { refundIntent: { identity: { observations: { refundedAt: Date | null }[] } | null } } | null };
export function expenseOccurredAt(property: ExpenseProperty, facts: ExpenseFacts): Date {
  if (facts.externalPaymentFee) {
    const capturedAt = facts.externalPaymentFee.capture.capturedAt;
    if (!capturedAt || !Number.isFinite(capturedAt.getTime())) throw Error("Actual original provider fee time required");
    return capturedAt;
  }
  if (facts.externalPaymentRefundFeeCorrection) {
    const refundedAt = facts.externalPaymentRefundFeeCorrection.refundIntent.identity?.observations[0]?.refundedAt;
    if (!refundedAt || !Number.isFinite(refundedAt.getTime())) throw Error("Actual original provider fee return time required");
    return refundedAt;
  }
  return facts.occurredAt ?? calendarDateStart(facts.occurredOn.toISOString().slice(0, 10), property.timezone);
}
/** The same native facts protect expense screens, source commands and audit disclosure. */
export function expenseResource(organizationId: string, property: ExpenseProperty, facts: ExpenseFacts, ownerId?: string | null): Resource {
  return { type: "expense", organizationId, id: facts.id, financialRecordId: facts.id, ownerId, propertyId: property.id,
    reservationId: facts.reservationId, city: property.cityId ?? property.city, region: property.regionId ?? property.region, status: facts.state,
    amount: facts.amount, occurredAt: expenseOccurredAt(property, facts), assignedUserAccountId: facts.createdBy, dataClass: "financial" };
}
export function viewableExpenseResource(ctx: AuthContext, property: ExpenseProperty, facts: ExpenseFacts, ownerIds: readonly string[], at = new Date()): Resource | null {
  const base = expenseResource(ctx.organizationId, property, facts);
  if (authorize(ctx, "view", base, at)) return base;
  return ownerIds.map(ownerId => expenseResource(ctx.organizationId, property, facts, ownerId)).find(resource => authorize(ctx, "view", resource, at)) ?? null;
}
