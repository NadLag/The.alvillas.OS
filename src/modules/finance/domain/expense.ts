import { z } from "zod";
export {expenseDraftSchema,type ExpenseDraftInput} from "./expense-input";
import type { Money } from "@/platform/money/money";
import type { ConfiguredExpenseAllocation } from "./configured-finance-rules";
import { allocateGrossRevenueByOwnerShare, assertFinancePostingsBalanced, type FinancePostingDraft, type PropertyOwnerShare } from "./reservation-revenue";
import { type Resource } from "@/platform/authz/authorize";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";

export const expenseEmergencyNoticeSchema = z.object({ ownerId: z.uuid(), routing: notificationRoutingSchema, recipients: z.array(z.uuid()).min(1) }).strict();
export type ExpenseEmergencyNotice = z.infer<typeof expenseEmergencyNoticeSchema>;
export { expenseResource, viewableExpenseResource, expenseOccurredAt } from "@/platform/authz/expense-resource";

type ExpenseFundingAccount = { id?: string; code: string; accountType: string; normalSide: string; archivedAt: Date | null;
  teamWallet?: { id: string; personId: string; person: { archivedAt: Date | null } } | null };
export function isExpenseFundingAccount(account: ExpenseFundingAccount): boolean {
  const location = ["ASSET", "ASSET_LOCATION"].includes(account.accountType) ||
    account.accountType === "STAFF_WALLET" && account.teamWallet?.person.archivedAt === null;
  return !account.archivedAt && location && account.normalSide === "DEBIT" && !account.code.startsWith("CASH_CUSTODY_");
}
export function expenseFundingWalletResource(organizationId: string, account: ExpenseFundingAccount, amount: string, occurredAt?: Date): Resource | null {
  const link = account.accountType === "STAFF_WALLET" ? account.teamWallet : null;
  return link ? { type: "wallet", organizationId, id: link.id, walletId: link.id, financialRecordId: account.id,
    assignedPersonId: link.personId, dataClass: "financial", amount, occurredAt } : null;
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
