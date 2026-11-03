import { describe, expect, it } from "vitest";
import { companyExpenseCommandSchema, companyExpenseCommandRecoverySchema, companyExpenseCommandResultSchema } from "@/modules/finance/domain/company-expense-command";
const id = "8c8e5075-451b-4252-8d19-28eecc807060";
const input = { operation: "CREATE", idempotencyKey: id, input: { amount: "0.07", currency: "MAD", category: "configured_cost", costCenter: "configured_center", dueOn: "2026-11-02", purpose: "Original company expense plan", reason: "Original explicit company estimate" } };
describe("native company command acknowledgement protocol", () => {
  it("reuses canonical native inputs and one scoped nonce without copying financial state into the receipt", () => {
    expect(companyExpenseCommandSchema.parse(input)).toEqual(input);
    const receipt = companyExpenseCommandResultSchema.parse({ requestId: id, idempotencyKey: id, operation: "CREATE", state: "SUCCEEDED", failureCode: null, companyExpenseId: id, resultId: id, version: 1, idempotent: false });
    expect(Object.keys(receipt)).not.toContain("input");expect(Object.keys(receipt)).not.toContain("amount");
    expect(companyExpenseCommandRecoverySchema.parse({ key: id })).toEqual({ key: id });
  });
  it.each([{ state: "SUCCEEDED" }, { amount: "99.00" }, { createdBy: id }, { dataClass: "FINANCIAL" }])("rejects client-substituted execution facts %o", extra => {
    expect(companyExpenseCommandSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it("requires actual result identity and an explicit terminal failure rather than an optimistic acknowledgement", () => {
    expect(companyExpenseCommandResultSchema.safeParse({ requestId: id, idempotencyKey: id, operation: "CREATE", state: "SUCCEEDED", failureCode: null }).success).toBe(false);
    expect(companyExpenseCommandResultSchema.safeParse({ requestId: id, idempotencyKey: id, operation: "CREATE", state: "CONFLICT", failureCode: null }).success).toBe(false);
    expect(companyExpenseCommandResultSchema.parse({ requestId: id, idempotencyKey: id, operation: "CREATE", state: "CONFLICT", failureCode: "SOURCE_CHANGED" }).state).toBe("CONFLICT");
  });
});
