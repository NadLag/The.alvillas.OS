import { z } from "zod";
import Decimal from "decimal.js";
import type { Money } from "@/platform/money/money";
import type { ConfiguredExpenseAllocation } from "./configured-finance-rules";
import { allocateGrossRevenueByOwnerShare, assertFinancePostingsBalanced, type FinancePostingDraft, type PropertyOwnerShare } from "./reservation-revenue";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { calendarDateStart } from "@/platform/time/calendar";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";

export const expenseEmergencyNoticeSchema = z.object({ ownerId: z.uuid(), routing: notificationRoutingSchema, recipients: z.array(z.uuid()).min(1) }).strict();
export type ExpenseEmergencyNotice = z.infer<typeof expenseEmergencyNoticeSchema>;
type ExpenseProperty = { id: string; cityId?: string | null; city?: string | null; regionId?: string | null; region?: string | null; timezone: string };
type ExpenseFacts = { id: string; amount: string; reservationId?: string | null; state: string; occurredOn: Date; createdBy: string };
export function expenseResource(organizationId: string, property: ExpenseProperty, facts: ExpenseFacts, ownerId?: string | null): Resource {
  return { type: "expense", organizationId, id: facts.id, financialRecordId: facts.id, ownerId, propertyId: property.id,
    reservationId: facts.reservationId, city: property.cityId ?? property.city, region: property.regionId ?? property.region, status: facts.state,
    amount: facts.amount, occurredAt: calendarDateStart(facts.occurredOn.toISOString().slice(0,10),property.timezone), assignedUserAccountId: facts.createdBy, dataClass: "financial" };
}
export function viewableExpenseResource(ctx: AuthContext, property: ExpenseProperty, facts: ExpenseFacts, ownerIds: readonly string[], at = new Date()): Resource | null {
  const base = expenseResource(ctx.organizationId,property,facts);
  if (authorize(ctx,"view",base,at)) return base;
  return ownerIds.map(ownerId=>expenseResource(ctx.organizationId,property,facts,ownerId)).find(resource=>authorize(ctx,"view",resource,at)) ?? null;
}

export const expenseDraftSchema = z.object({
  propertyId: z.uuid(), reservationId: z.uuid().optional(), category: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).pipe(z.string().refine(value => new Decimal(value).gt(0))),
  currency: z.string().regex(/^[A-Z]{3}$/u), purpose: z.string().trim().min(3).max(1000),
  occurredOn: z.iso.date(), fundingAccountId: z.uuid(), emergency: z.boolean().default(false), idempotencyKey: z.uuid(),
  reason: z.string().trim().min(6).max(500)
}).strict();
export type ExpenseDraftInput = z.infer<typeof expenseDraftSchema>;

export function isExpenseFundingAccount(account: { code: string; accountType: string; normalSide: string; archivedAt: Date | null }): boolean {
  return !account.archivedAt && ["ASSET", "ASSET_LOCATION"].includes(account.accountType) && account.normalSide === "DEBIT" && !account.code.startsWith("CASH_CUSTODY_");
}

export function expensePostings(input: {
  amount: Money; allocation: Pick<ConfiguredExpenseAllocation,"ownerAmount"|"alvillasAmount"|"guestAmount">; owners: readonly PropertyOwnerShare[]; ownerAmounts?: ReadonlyArray<{ ownerId: string; amount: Money }>;
  ownerAccounts: ReadonlyMap<string, string>; companyExpenseAccountId: string; guestReceivableAccountId: string;
  fundingAccountId: string; dimensions: Record<string, unknown>;
}): FinancePostingDraft[] {
  const { amount, allocation, dimensions } = input;
  if (!amount.amount.gt(0) || !allocation.ownerAmount.add(allocation.alvillasAmount).add(allocation.guestAmount).amount.eq(amount.amount) ||
    [allocation.ownerAmount, allocation.alvillasAmount, allocation.guestAmount].some(share => share.currency !== amount.currency || share.amount.lt(0))) throw new Error("Expense allocation must conserve positive money in one currency");
  const postings: FinancePostingDraft[] = [];
  const debit = (ledgerAccountId: string | undefined, share: Money, bucket: string, extra = {}) => {
    if (!share.amount.gt(0)) return;
    if (!ledgerAccountId || ledgerAccountId === input.fundingAccountId) throw new Error("Expense funding and beneficiary accounts must be distinct");
    postings.push({ ledgerAccountId, side: "DEBIT", amount: share, bucket, dimensions: { ...dimensions, ...extra } });
  };
  if (allocation.ownerAmount.amount.gt(0) || input.ownerAmounts) {
    const owners = input.ownerAmounts ?? allocateGrossRevenueByOwnerShare(allocation.ownerAmount, input.owners).map(owner => ({ ownerId: owner.ownerId, amount: owner.grossAmount }));
    const ids = new Set<string>(); let allocated = allocation.ownerAmount.subtract(allocation.ownerAmount);
    for (const owner of owners) {
      if (ids.has(owner.ownerId) || !input.owners.some(source => source.ownerId === owner.ownerId) || owner.amount.amount.lt(0)) throw new Error("Expense owner allocation requires distinct source owners");
      ids.add(owner.ownerId); allocated = allocated.add(owner.amount);
      debit(input.ownerAccounts.get(owner.ownerId), owner.amount, "OWNER_EXPENSE", { owner_id: owner.ownerId });
    }
    if (!allocated.amount.eq(allocation.ownerAmount.amount)) throw new Error("Expense owner allocation must conserve its configured total");
  }
  debit(input.companyExpenseAccountId, allocation.alvillasAmount, "ALVILLAS_EXPENSE");
  debit(input.guestReceivableAccountId, allocation.guestAmount, "GUEST_EXPENSE");
  postings.push({ ledgerAccountId: input.fundingAccountId, side: "CREDIT", amount, bucket: "EXPENSE_PAYMENT", dimensions });
  assertFinancePostingsBalanced(postings); return postings;
}
