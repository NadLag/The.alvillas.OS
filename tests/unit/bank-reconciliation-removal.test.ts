import { describe, expect, it } from "vitest";
import { bankReconciliationReviewInput, bankReconciliationMatchInput } from "@/modules/finance/domain/bank-reconciliation";
import { bankReconciliationPlanSchema } from "@/modules/finance/domain/bank-reconciliation-command";

const account = "018f0a0b-0000-7000-9000-000000000011", posting = "018f0a0b-0000-7000-9000-000000000012", line = "018f0a0b-0000-7000-9000-000000000013";
const original = { action: "MATCH", accountId: account, currency: "MAD", expected: [{ id: posting, amount: "0.07" }], actual: [{ id: line, amount: "0.07" }], reason: "Review the original bank facts", varianceAction: null };
const removal = { ...original, actual: [], evidence: [line] };
describe("bank removal is retained evidence rather than a synthetic movement", () => {
  it("preserves the exact ordinary intent shape and key order without inventing an evidence field", () => {
    expect(JSON.stringify(bankReconciliationReviewInput.parse(original))).toBe(JSON.stringify(original));
    const input = { ...original, idempotencyKey: posting, reviewFingerprint: "a".repeat(64) };
    expect(JSON.stringify(bankReconciliationMatchInput.parse(input))).toBe(JSON.stringify(input));
  });
  it("retains an empty actual side and normalized removal identities in the complete command", () => {
    const value = bankReconciliationMatchInput.parse({ ...removal, evidence: [line.toUpperCase()], idempotencyKey: posting, reviewFingerprint: "a".repeat(64) });
    expect(value.actual).toEqual([]); expect(value.evidence).toEqual([line]); expect(Object.keys(value)).toEqual(["action", "accountId", "currency", "expected", "actual", "reason", "varianceAction", "evidence", "idempotencyKey", "reviewFingerprint"]);
  });
  it.each([{ ...original, actual: [] }, { ...removal, evidence: [] }, { ...removal, evidence: [line, line] }, { ...original, evidence: [line] }])("rejects absent, duplicate and mixed removal choices", value => {
    expect(bankReconciliationReviewInput.safeParse(value).success).toBe(false);
  });
  it("requires original evidence in a zero-actual result and retains it in the typed plan", () => {
    const value = { unit: "MONEY:MAD", expected: "0.00", actual: "0.00", variance: "0.00", classification: "EXACT", reason: original.reason, varianceAction: null,
      allocations: { expected: [{ sourceKey: posting, original: "0.07", allocatedBefore: "0.00", amount: "0.07" }], actual: [] }, evidence: [{ side: "ACTUAL", sourceKey: line, fingerprint: "a".repeat(64) }] };
    expect(bankReconciliationPlanSchema.parse(value)).toEqual(value);
    expect(bankReconciliationPlanSchema.safeParse({ ...value, evidence: [] }).success).toBe(false);
    expect(bankReconciliationPlanSchema.safeParse({ ...value, evidence: [{ ...value.evidence[0], side: "EXPECTED" }] }).success).toBe(false);
  });
});
