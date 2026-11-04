import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { otaReconciliationPlan } from "@/modules/finance/domain/ota-reconciliation";
import { reconciliationPlan, ReconciliationSourceError } from "@/modules/finance/domain/reconciliation";
import { moneyReconciliationMeasure } from "@/modules/finance/domain/reconciliation-money";

const money = (value: string, currency = "MAD") => Money.of(value, currency);
const posting = (id: string, value: string) => ({ id, amount: money(value) });
const input = (actual = "0.07") => ({ currency: "MAD", minorUnit: 2, expectedPayout: money("0.07"), actualReceipt: money(actual),
  expected: [posting("original-expected-posting", "0.07")], actual: [posting("original-receipt-posting", actual)], zeroReceiptEvidence: null,
  reason: "Review original retained OTA settlement", varianceAction: actual === "0.07" ? null : "Investigate the original settlement difference" });

describe("OTA uses the shared exact source reconciliation", () => {
  it.each([["0.07", "0.00", "MATCHED"], ["0.03", "-0.04", "OPEN_VARIANCE"], ["0.08", "0.01", "OPEN_VARIANCE"]])("preserves signed original differences for actual %s", (actual, variance, state) => {
    const value = input(actual), before = JSON.stringify(value), result = otaReconciliationPlan(value);
    expect(result).toMatchObject({ state, plan: { unit: "MONEY:MAD", expected: "0.07", actual, variance, reason: value.reason, varianceAction: value.varianceAction } });
    expect(result.plan.allocations.expected[0].sourceKey).toBe("original-expected-posting");
    expect(result.plan.allocations.actual[0].sourceKey).toBe("original-receipt-posting");
    expect(Object.hasOwn(result.plan, "classification")).toBe(false); expect(JSON.stringify(value)).toBe(before);
  });
  it("requires retained evidence for a genuine zero receipt and never creates a zero posting", () => {
    const value = { ...input("0.00"), actual: [], zeroReceiptEvidence: { side: "ACTUAL" as const, sourceKey: "original-settlement", fingerprint: "a".repeat(64) } };
    expect(otaReconciliationPlan(value)).toMatchObject({ state: "OPEN_VARIANCE", plan: { expected: "0.07", actual: "0.00", variance: "-0.07", allocations: { actual: [] }, evidence: [value.zeroReceiptEvidence] } });
    expect(() => otaReconciliationPlan({ ...value, zeroReceiptEvidence: null })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan({ ...value, zeroReceiptEvidence: { ...value.zeroReceiptEvidence, side: "EXPECTED" } })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan({ ...value, actual: [posting("invented-zero", "0.00")] })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan({ ...input(), zeroReceiptEvidence: value.zeroReceiptEvidence })).toThrow(ReconciliationSourceError);
  });
  it("rejects mismatched source sums, reused identities, duplicate sources and absent variance action", () => {
    expect(() => otaReconciliationPlan({ ...input(), actual: [posting("wrong-original", "0.06")] })).toThrow();
    expect(() => otaReconciliationPlan({ ...input(), actual: [posting("original-expected-posting", "0.07")] })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan({ ...input(), expected: [posting("duplicate", "0.03"), posting("duplicate", "0.04")] })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan({ ...input("0.03"), varianceAction: null })).toThrow(ReconciliationSourceError);
  });
  it("denies foreign currencies, fractional zero-decimal amounts and negative receipts", () => {
    expect(() => otaReconciliationPlan({ ...input(), actualReceipt: money("0.07", "EUR") })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan({ ...input(), minorUnit: 0 })).toThrow(ReconciliationSourceError);
    expect(() => otaReconciliationPlan(input("-0.01"))).toThrow(ReconciliationSourceError);
  });
  it("preserves the existing bank snapshot byte order and configured tolerance classification", () => {
    const measure = moneyReconciliationMeasure("MAD", 2), expected = { sourceKey: "original", original: money("0.07"), allocatedBefore: money("0.00"), amount: money("0.07") }, actual = { ...expected, sourceKey: "bank", original: money("0.08"), amount: money("0.08") };
    const result = reconciliationPlan(measure, { expected: [expected], actual: [actual], evidence: [], tolerance: money("0.01"), reason: "Original review", varianceAction: "Investigate original source" });
    expect(JSON.stringify(result)).toBe(JSON.stringify({ unit: "MONEY:MAD", expected: "0.07", actual: "0.08", variance: "0.01", classification: "WITHIN_TOLERANCE", reason: "Original review", varianceAction: "Investigate original source",
      allocations: { expected: [{ sourceKey: "original", original: "0.07", allocatedBefore: "0.00", amount: "0.07" }], actual: [{ sourceKey: "bank", original: "0.08", allocatedBefore: "0.00", amount: "0.08" }] }, evidence: [] }));
  });
  it("retains exact provider totals for 200 generated large native Money amounts", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 999999999999999999n }), cents => {
      const digits = cents.toString().padStart(3, "0"), amount = Money.of(digits.slice(0, -2) + "." + digits.slice(-2), "MAD"), value = { ...input(), expectedPayout: amount, actualReceipt: amount, expected: [{ id: "expected", amount }], actual: [{ id: "actual", amount }] };
      expect(otaReconciliationPlan(value).plan).toMatchObject({ expected: amount.toJSON().amount, actual: amount.toJSON().amount, variance: "0.00" });
    }), { numRuns: 200 });
  });
});
