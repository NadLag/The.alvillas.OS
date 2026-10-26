import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Money } from "@/platform/money/money";
import { allocateConfiguredExpense } from "@/modules/finance/domain/configured-finance-rules";
import { expenseDraftSchema, expensePostings } from "@/modules/finance/domain/expense";

describe("native expense allocation conserves exact money", () => {
  it("does not create a second cent when a shared expense rounds each half upward", () => {
    const allocation = allocateConfiguredExpense({ default_treatment: "SHARED", categories: { supplies: { treatment: "SHARED", owner_share_bps: 5000, alvillas_share_bps: 5000 } } },
      { category: "supplies", amount: Money.of("0.01", "MAD") });
    expect(allocation.ownerAmount.add(allocation.alvillasAmount).add(allocation.guestAmount).toJSON()).toEqual({ amount: "0.01", currency: "MAD" });
  });
  for (const treatment of ["OWNER_PAID", "ALVILLAS_PAID", "INCLUDED_IN_COMMISSION", "GUEST_PAID", "REIMBURSABLE", "DEDUCT_FROM_PAYOUT"])
    it(`balances the configured ${treatment} recipe without mutating a balance`, () => {
      const amount = Money.of("2400.01", "MAD"), allocation = allocateConfiguredExpense({ default_treatment: treatment }, { category: "maintenance", amount });
      const postings = expensePostings({ amount, allocation, owners: [{ ownerId: "owner-a", ownerName: "Fictional owner A", shareBps: 6000 }, { ownerId: "owner-b", ownerName: "Fictional owner B", shareBps: 4000 }],
        ownerAccounts: new Map([["owner-a", "payable-a"], ["owner-b", "payable-b"]]), companyExpenseAccountId: "company-expense", guestReceivableAccountId: "guest-receivable", fundingAccountId: "bank",
        dimensions: { expenseId: "expense", category: "maintenance" } });
      const debits = postings.filter(posting => posting.side === "DEBIT").reduce((sum, posting) => sum.add(posting.amount), Money.zero("MAD"));
      expect(debits.toJSON()).toEqual(amount.toJSON()); expect(postings.at(-1)).toMatchObject({ ledgerAccountId: "bank", side: "CREDIT" });
      expect(postings.every(posting => posting.amount.amount.gt(0))).toBe(true);
    });
  it("refuses missing or reused beneficiary accounts and mixed-currency allocations", () => {
    const amount = Money.of("25", "MAD"), allocation = allocateConfiguredExpense({ default_treatment: "OWNER_PAID" }, { category: "supplies", amount });
    const input = { amount, allocation, owners: [{ ownerId: "owner-a", ownerName: "Fictional owner", shareBps: 10000 }], ownerAccounts: new Map<string,string>(),
      companyExpenseAccountId: "company", guestReceivableAccountId: "guest", fundingAccountId: "bank", dimensions: {} };
    expect(() => expensePostings(input)).toThrow("distinct");
    expect(() => expensePostings({ ...input, ownerAccounts: new Map([["owner-a", "bank"]]) })).toThrow("distinct");
    expect(() => expensePostings({ ...input, allocation: { ...allocation, alvillasAmount: Money.zero("EUR") } })).toThrow();
  });
  it("rejects invalid financial input instead of accepting caller-supplied snapshots or approval states", () => {
    const valid = { propertyId: randomUUID(), category: "maintenance", amount: "500.25", currency: "MAD", purpose: "Dedicated fictional repair",
      occurredOn: "2026-10-26", fundingAccountId: randomUUID(), idempotencyKey: randomUUID(), reason: "Dedicated expense input proof" };
    expect(expenseDraftSchema.safeParse(valid).success).toBe(true);
    for (const override of [{ amount: "0" }, { amount: "500,25" }, { approvalState: "APPROVED" }, { policySnapshot: { bypass: true } }])
      expect(expenseDraftSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});
