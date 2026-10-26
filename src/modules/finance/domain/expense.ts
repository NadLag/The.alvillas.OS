import { z } from "zod";
import Decimal from "decimal.js";
import type { Money } from "@/platform/money/money";
import type { ConfiguredExpenseAllocation } from "./configured-finance-rules";
import { allocateGrossRevenueByOwnerShare, assertFinancePostingsBalanced, type FinancePostingDraft, type PropertyOwnerShare } from "./reservation-revenue";

export const expenseDraftSchema = z.object({
  propertyId: z.uuid(), reservationId: z.uuid().optional(), category: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).pipe(z.string().refine(value => new Decimal(value).gt(0))),
  currency: z.string().regex(/^[A-Z]{3}$/u), purpose: z.string().trim().min(3).max(1000),
  occurredOn: z.iso.date(), fundingAccountId: z.uuid(), emergency: z.boolean().default(false), idempotencyKey: z.uuid(),
  reason: z.string().trim().min(6).max(500)
}).strict();
export type ExpenseDraftInput = z.infer<typeof expenseDraftSchema>;

export function expensePostings(input: {
  amount: Money; allocation: ConfiguredExpenseAllocation; owners: readonly PropertyOwnerShare[];
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
  if (allocation.ownerAmount.amount.gt(0)) for (const owner of allocateGrossRevenueByOwnerShare(allocation.ownerAmount, input.owners))
    debit(input.ownerAccounts.get(owner.ownerId), owner.grossAmount, "OWNER_EXPENSE", { owner_id: owner.ownerId });
  debit(input.companyExpenseAccountId, allocation.alvillasAmount, "ALVILLAS_EXPENSE");
  debit(input.guestReceivableAccountId, allocation.guestAmount, "GUEST_EXPENSE");
  postings.push({ ledgerAccountId: input.fundingAccountId, side: "CREDIT", amount, bucket: "EXPENSE_PAYMENT", dimensions });
  assertFinancePostingsBalanced(postings); return postings;
}
