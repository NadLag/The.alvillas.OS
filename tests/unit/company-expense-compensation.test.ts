import { describe, expect, it } from "vitest";
import { companyExpenseCompensationCommandSchema, companyExpenseCompensationHistorySchema } from "@/modules/finance/domain/company-expense-compensation";
const id = "8c8e5075-451b-4252-8d19-28eecc807060";
const input = { operation: "ATTACH", companyExpenseId: id, employeeCostId: id, expectedSourceVersion: 0, expectedPlanVersion: 1, reason: "Associate actual recognized employee company cost" };
describe("actual company employee-cost source command", () => {
  it("requires native source and plan versions and canonicalizes source identities", () => {
    expect(companyExpenseCompensationCommandSchema.parse({ ...input, employeeCostId: id.toUpperCase() })).toEqual(input);
    expect(companyExpenseCompensationCommandSchema.parse({ ...input, operation: "RELEASE", expectedSourceVersion: 1 }).operation).toBe("RELEASE");
  });
  it.each([{ amount: "1.00" }, { currency: "MAD" }, { claimId: id }, { transactionId: id }, { dataClass: "FINANCIAL" }, { paid: true }])("rejects fabricated financial facts and salary downgrades %o", extra => {
    expect(companyExpenseCompensationCommandSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it("rejects missing or stale version shapes and preserves the bounded history cursor contract", () => {
    for (const invalid of [{ ...input, expectedSourceVersion: -1 }, { ...input, expectedPlanVersion: 0 }, { ...input, employeeCostId: undefined }, { ...input, reason: "short" }])
      expect(companyExpenseCompensationCommandSchema.safeParse(invalid).success).toBe(false);
    expect(companyExpenseCompensationHistorySchema.parse({ companyExpenseId: id, before: id })).toEqual({ companyExpenseId: id, before: id });
    expect(companyExpenseCompensationHistorySchema.safeParse({ companyExpenseId: id, limit: 10000 }).success).toBe(false);
  });
});
