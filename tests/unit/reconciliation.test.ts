import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { reconciliationPlan, ReconciliationBudgetError, ReconciliationSourceError, type ReconciliationMeasure } from "@/modules/finance/domain/reconciliation";
import { moneyReconciliationMeasure } from "@/modules/finance/domain/reconciliation-money";

const money = (amount: string, currency = "MAD") => Money.of(amount, currency), measure = moneyReconciliationMeasure("MAD", 2);
const source = (sourceKey: string, original: string, amount = original, allocatedBefore = "0.00") => ({ sourceKey, original: money(original), amount: money(amount), allocatedBefore: money(allocatedBefore) });
const reason = "Confirmed the actual original source evidence";
describe("shared exact expected, actual and variance plans", () => {
  it("retains every cent across split, grouped and signed original Money sources", () => {
    const plan = reconciliationPlan(measure, { expected: [source("deposit", "100.00"), source("fee", "-0.01", "0.01")], actual: [source("bank", "99.99")], evidence: [], tolerance: money("0.00"), reason, varianceAction: null });
    expect(plan).toMatchObject({ expected: "99.99", actual: "99.99", variance: "0.00", classification: "EXACT", varianceAction: null });
    expect(plan.allocations.expected.map(row => row.sourceKey)).toEqual(["deposit", "fee"]);
  });
  it("never exceeds original derived source budgets, including repeated and partial allocations", () => {
    const base = { actual: [source("bank", "0.03")], evidence: [], tolerance: money("0.00"), reason, varianceAction: null };
    expect(reconciliationPlan(measure, { ...base, expected: [source("posted", "0.07", "0.03", "0.04")] }).classification).toBe("EXACT");
    expect(() => reconciliationPlan(measure, { ...base, expected: [source("posted", "0.07", "0.04", "0.04")] })).toThrow(ReconciliationBudgetError);
    expect(() => reconciliationPlan(measure, { ...base, expected: [source("posted", "0.07", "0.01", "-0.01")] })).toThrow(ReconciliationBudgetError);
    expect(() => reconciliationPlan(measure, { ...base, expected: [source("same", "0.01"), source("same", "0.02")] })).toThrow(ReconciliationSourceError);
  });
  it("classifies an open variance using the configured tolerance and retains its explicit action", () => {
    const input = { expected: [source("posted", "0.07")], actual: [source("bank", "0.08")], evidence: [], tolerance: money("0.01"), reason, varianceAction: "Investigate the original retained bank correction" };
    expect(reconciliationPlan(measure, input)).toMatchObject({ expected: "0.07", actual: "0.08", variance: "0.01", classification: "WITHIN_TOLERANCE", varianceAction: input.varianceAction });
    expect(reconciliationPlan(measure, { ...input, tolerance: money("0.00") }).classification).toBe("OUTSIDE_TOLERANCE");
    expect(() => reconciliationPlan(measure, { ...input, varianceAction: null })).toThrow(ReconciliationSourceError);
  });
  it("requires explicit retained evidence for an empty side without creating a synthetic movement", () => {
    const input = { expected: [source("original", "0.07"), source("actual-opposite", "-0.07", "0.07")], actual: [], tolerance: money("0.00"), reason, varianceAction: null };
    expect(() => reconciliationPlan(measure, { ...input, evidence: [] })).toThrow(ReconciliationSourceError);
    const plan = reconciliationPlan(measure, { ...input, evidence: [{ side: "ACTUAL", sourceKey: "retained-bank-removal", fingerprint: "a".repeat(64) }] });
    expect(plan).toMatchObject({ expected: "0.00", actual: "0.00", variance: "0.00", classification: "EXACT" }); expect(plan.allocations.actual).toEqual([]);
  });
  it("denies mixed currencies, invalid precision, zero allocations and negative tolerances", () => {
    const input = { expected: [source("posted", "1.00")], actual: [source("bank", "1.00")], evidence: [], tolerance: money("0.00"), reason, varianceAction: null };
    expect(() => reconciliationPlan(measure, { ...input, actual: [{ ...source("foreign", "1.00"), original: money("1.00", "EUR") }] })).toThrow(ReconciliationSourceError);
    expect(() => reconciliationPlan(moneyReconciliationMeasure("MAD", 0), { ...input, tolerance: money("0.01") })).toThrow(ReconciliationSourceError);
    expect(() => reconciliationPlan(measure, { ...input, expected: [source("zero", "0.00")] })).toThrow(ReconciliationBudgetError);
    expect(() => reconciliationPlan(measure, { ...input, tolerance: money("-0.01") })).toThrow(ReconciliationSourceError);
  });
  it("uses the same workflow for exact operational quantities without treating counts as currencies", () => {
    const quantity: ReconciliationMeasure<bigint> = { unit: "QUANTITY:PIECE", zero: () => 0n, assert: () => {}, add: (a, b) => a + b, subtract: (a, b) => a - b, compare: (a, b) => a < b ? -1 : a > b ? 1 : 0, serialize: value => value.toString() };
    const plan = reconciliationPlan(quantity, { expected: [{ sourceKey: "original-issue", original: 40n, amount: 40n, allocatedBefore: 0n }], actual: [{ sourceKey: "actual-return", original: 38n, amount: 38n, allocatedBefore: 0n }], evidence: [], tolerance: 0n, reason, varianceAction: "Investigate the two missing original items" });
    expect(plan).toMatchObject({ unit: "QUANTITY:PIECE", expected: "40", actual: "38", variance: "-2", classification: "OUTSIDE_TOLERANCE" });
  });
  it("preserves exact large allocations and source inputs across 200 generated native split plans", () => {
    const amount = (units: bigint) => { const text = units.toString().padStart(3, "0"); return text.slice(0, -2) + "." + text.slice(-2); };
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 999999999999999999n }), cents => {
      const input = { expected: [source("original", amount(cents))], actual: [source("bank", amount(cents))], evidence: [], tolerance: money("0.00"), reason, varianceAction: null }, before = JSON.stringify(input);
      expect(reconciliationPlan(measure, input).variance).toBe("0.00"); expect(JSON.stringify(input)).toBe(before);
    }), { numRuns: 200 });
  });
});
