import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Money } from "@/platform/money/money";
import { allocateConfiguredExpense, evaluateConfiguredApproval } from "@/modules/finance/domain/configured-finance-rules";
import { approvalThresholdsConfigSchema } from "@/platform/config/rule-registry";
import { expenseDraftSchema, expensePostings } from "@/modules/finance/domain/expense";
import { allocateGrossRevenueByOwnerShare } from "@/modules/finance/domain/reservation-revenue";

describe("native expense allocation conserves exact money", () => {
  it("never gives an owner a negative share when several tiny shares round upward", () => {
    const amount = Money.of("0.02", "MAD"), shares = allocateGrossRevenueByOwnerShare(amount,
      ["a","b","c","d"].map(ownerId => ({ ownerId, ownerName: ownerId, shareBps: 2500 })));
    expect(shares.every(share => share.grossAmount.amount.gte(0))).toBe(true);
    expect(shares.reduce((sum, share) => sum.add(share.grossAmount), Money.zero("MAD")).toJSON()).toEqual(amount.toJSON());
  });
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
  it("preserves different owners' configured treatments instead of redistributing their costs by ownership again", () => {
    const amount = Money.of("1000", "MAD"), allocation = allocateConfiguredExpense({ default_treatment: "SHARED", categories: {
      maintenance: { treatment: "SHARED", owner_share_bps: 7500, alvillas_share_bps: 2500 }
    } }, { category: "maintenance", amount });
    const postings = expensePostings({ amount, allocation,
      owners: [{ ownerId: "a", ownerName: "Owner A", shareBps: 5000 }, { ownerId: "b", ownerName: "Owner B", shareBps: 5000 }],
      ownerAmounts: [{ ownerId: "a", amount: Money.of("500", "MAD") }, { ownerId: "b", amount: Money.of("250", "MAD") }],
      ownerAccounts: new Map([["a","claim-a"],["b","claim-b"]]), companyExpenseAccountId: "company", guestReceivableAccountId: "guest", fundingAccountId: "bank", dimensions: {} });
    expect(postings.find(row => row.ledgerAccountId === "claim-a")?.amount.toJSON().amount).toBe("500.00");
    expect(postings.find(row => row.ledgerAccountId === "claim-b")?.amount.toJSON().amount).toBe("250.00");
  });
  it("rejects invalid financial input instead of accepting caller-supplied snapshots or approval states", () => {
    const valid = { propertyId: randomUUID(), category: "maintenance", amount: "500.25", currency: "MAD", purpose: "Dedicated fictional repair",
      occurredOn: "2026-10-26", fundingAccountId: randomUUID(), idempotencyKey: randomUUID(), reason: "Dedicated expense input proof" };
    expect(expenseDraftSchema.safeParse(valid).success).toBe(true);
    for (const override of [{ amount: "0" }, { amount: "500,25" }, { approvalState: "APPROVED" }, { policySnapshot: { bypass: true } }])
      expect(expenseDraftSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
  it("evaluates custom approval conditions with the existing bounded rule engine", () => {
    const config = { thresholds: [{ key: "nonemergency_maintenance", conditions: { all: [
      { path: "expense.category", op: "=", value: "maintenance" }, { path: "expense.emergency", op: "=", value: false }
    ] }, requires_approval_from: ["manager_owner"] }] };
    expect(evaluateConfiguredApproval(config, { category: "maintenance", amount: Money.of("500", "MAD"), emergency: false }).requiredSteps).toEqual(["manager_owner"]);
    expect(evaluateConfiguredApproval(config, { category: "maintenance", amount: Money.of("500", "MAD"), emergency: true }).requiredSteps).toEqual([]);
  });
  it("rejects unsafe or excessive condition trees and fails closed on missing referenced configuration", () => {
    const make = (conditions: unknown) => ({ thresholds: [{ key: "custom", conditions, requires_approval_from: ["owner"] }] });
    expect(approvalThresholdsConfigSchema.safeParse(make({ path: "expense.__proto__", op: "exists" })).success).toBe(false);
    let tree: unknown = { path: "expense.amount", op: ">", value: "100" }; for (let index=0; index<100; index++) tree = { not: tree };
    expect(approvalThresholdsConfigSchema.safeParse(make(tree)).success).toBe(false);
    expect(() => evaluateConfiguredApproval(make({ path: "expense.amount", op: ">", value: { config: "finance.missing" } }),
      { category: "maintenance", amount: Money.of("500", "MAD") })).toThrow("automation_config_missing");
  });
});
