import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorize } from "@/platform/authz/authorize";
import { businessPersonalTransferPolicySchema } from "@/platform/ledger/business-personal-transfer-policy";
import { canUseHousehold, householdAuthority, householdMemberSchema } from "@/modules/personal/domain/household-access";
import { financeEntrySchema, personalAmountSchema, signedMoney } from "@/modules/personal/domain/personal-finance";
import { totalsByCurrency } from "@/modules/personal/domain/report-totals";

describe("Personal OS domain", () => {
  it("scopes grants to one household and keeps child, household and business authority independent", () => {
    const householdId = randomUUID();
    const identity = { organizationId: randomUUID(), accountId: randomUUID() };
    const base = { ...identity, householdId, isSteward: false, revokedAt: null };
    const nadir = householdAuthority(identity, { ...base, isSteward: true, isChild: false, grants: [] });
    const hajar = householdAuthority(identity, { ...base, isChild: false, grants: ["expenses:view", "expenses:edit", "investments:view"] });
    const anis = householdAuthority(identity, { ...base, isChild: true, grants: ["savings:view"] });
    const youssef = householdAuthority(identity, { ...base, isChild: true, grants: [] });
    expect(canUseHousehold(nadir, householdId, "members", "edit")).toBe(true);
    expect(canUseHousehold(hajar, householdId, "expenses", "edit")).toBe(true);
    expect(canUseHousehold(hajar, householdId, "investments", "edit")).toBe(false);
    expect(canUseHousehold(anis, householdId, "savings")).toBe(true);
    expect(canUseHousehold(anis, householdId, "members", "edit")).toBe(false);
    expect(canUseHousehold(youssef, householdId, "savings")).toBe(false);
    expect(canUseHousehold(nadir, randomUUID(), "members", "edit")).toBe(false);
    expect(authorize(nadir, "view", { type: "financial_transaction", organizationId: identity.organizationId })).toBe(false);
    expect(householdAuthority({ ...identity, organizationId: randomUUID() }, { ...base, isChild: false, grants: ["expenses:view"] }).permissions.size).toBe(0);
    expect(householdMemberSchema.safeParse({ accountId: identity.accountId, displayName: "Child", isChild: true, grants: ["investments:edit"] }).success).toBe(false);
  });

  it("parses localized decimal text exactly and rejects invalid cash movements", () => {
    expect(personalAmountSchema.parse("٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣٫٠٧")).toBe("9007199254740993.07");
    expect(personalAmountSchema.parse("100,20")).toBe("100.20");
    expect(personalAmountSchema.safeParse("1.001").success).toBe(false);
    expect(financeEntrySchema.safeParse({
      id: randomUUID(), label: "Income", category: "Salary", effectiveOn: "2026-11-19", currency: "MAD", amount: "0", kind: "INCOME"
    }).success).toBe(false);
  });

  it("an immutable opposite movement cancels the exact original amount in every currency", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 999999999999999999n }), fc.boolean(), (minor, withdrawal) => {
      const digits = minor.toString().padStart(3, "0");
      const amount = digits.slice(0, -2) + "." + digits.slice(-2);
      const entry = { amount, withdrawal, currency: "MAD" };
      expect(signedMoney({ ...entry, reversesId: null }).add(signedMoney({ ...entry, reversesId: randomUUID() })).amount.isZero()).toBe(true);
    }));
    expect(totalsByCurrency([
      { kind: "ASSET", amount: "9007199254740993.07", currency: "MAD" },
      { kind: "LIABILITY", amount: "9007199254740993.06", currency: "MAD" },
      { kind: "ASSET", amount: "20.20", currency: "EUR" }
    ], ["LIABILITY"], ["ASSET"])).toEqual([{ currency: "MAD", amount: "0.01" }, { currency: "EUR", amount: "20.20" }]);
  });

  it("validates distinctly categorized approved transfer accounts", () => {
    const category = { category: "Approved settlement", cash_account_code: "BANK", company_account_code: "CAPITAL" };
    expect(businessPersonalTransferPolicySchema.safeParse({ approval_reference: "REVIEWED", categories: [category] }).success).toBe(true);
    expect(businessPersonalTransferPolicySchema.safeParse({ approval_reference: "REVIEWED", categories: [category, category] }).success).toBe(false);
    expect(businessPersonalTransferPolicySchema.safeParse({ approval_reference: "", categories: [category] }).success).toBe(false);
  });
});
