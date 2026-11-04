import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { stocktakeReconciliation } from "@/platform/inventory/stocktake-reconciliation";
import { ReconciliationSourceError } from "@/modules/finance/domain/reconciliation";

function fixture(expected = "5", actual = "3") {
  const observation = { id: randomUUID(), organizationId: randomUUID(), locationId: randomUUID(), itemId: randomUUID(),
    expectedRevision: "1", revision: "2", expectedQuantity: expected, countedQuantity: actual };
  const delta = BigInt(actual) - BigInt(expected);
  return { observation, movement: delta === 0n ? null : { id: randomUUID(), organizationId: observation.organizationId,
    locationId: observation.locationId, itemId: observation.itemId, stocktakeId: observation.id,
    revision: observation.revision, quantityDelta: delta.toString() }, unit: "pieces", reason: "Retain the original assigned physical count" };
}
describe("original native inventory reconciliation", () => {
  it("retains an exact observation without inventing a movement, tolerance or unresolved action", () => {
    const f = fixture("5", "5"), before = JSON.stringify(f), result = stocktakeReconciliation(f);
    expect(result).toMatchObject({ provider: "INVENTORY", sourceType: "STOCKTAKE", sourceId: f.observation.id, state: "MATCHED",
      plan: { unit: "QUANTITY:pieces", expected: "5", actual: "5", variance: "0", varianceAction: null, evidence: [] } });
    expect(result.plan).not.toHaveProperty("classification"); expect(JSON.stringify(f)).toBe(before);
  });
  it("keeps losses and gains open and points to the exact original adjustment", () => {
    for (const actual of ["3", "7"]) {
      const f = fixture("5", actual), result = stocktakeReconciliation(f);
      expect(result.state).toBe("OPEN_VARIANCE"); expect(result.plan.variance).toBe(actual === "3" ? "-2" : "2");
      expect(result.plan.varianceAction).toBe(`INVENTORY_STOCKTAKE_ADJUSTMENT:${f.movement!.id}`);
      expect(result.plan.reason).toBe(f.reason); expect(result.plan.allocations.actual[0].sourceKey).toBe(`${f.observation.id}:ACTUAL`);
    }
  });
  it("binds genuine zero sides to immutable observations without synthetic quantities or sources", () => {
    for (const [expected, actual] of [["0", "0"], ["0", "3"], ["3", "0"]]) {
      const f = fixture(expected, actual), result = stocktakeReconciliation(f);
      expect(result.plan.expected).toBe(expected); expect(result.plan.actual).toBe(actual);
      for (const [side, value] of [["EXPECTED", expected], ["ACTUAL", actual]]) {
        const allocation = side === "EXPECTED" ? result.plan.allocations.expected : result.plan.allocations.actual;
        if (value === "0") {
          expect(allocation).toEqual([]); expect(result.plan.evidence).toContainEqual({ side, sourceKey: `${f.observation.id}:${side}`, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown });
        } else expect(allocation).toHaveLength(1);
      }
    }
  });
  it("preserves exact large counts and signed deltas beyond JavaScript integer precision", () => {
    fc.assert(fc.property(fc.bigInt({ min: 9007199254740993n, max: 9223372036854775807n }), count => {
      const f = fixture(count.toString(), (count - 1n).toString()), before = JSON.stringify(f), result = stocktakeReconciliation(f);
      expect(result.plan.expected).toBe(count.toString()); expect(result.plan.actual).toBe((count - 1n).toString());
      expect(result.plan.variance).toBe("-1"); expect(JSON.stringify(f)).toBe(before);
    }), { numRuns: 200 });
  });
  it("rejects absent, unrelated, cross-tenant and altered native adjustment evidence", () => {
    const f = fixture(), movement = f.movement!;
    expect(() => stocktakeReconciliation({ ...f, movement: null })).toThrow(ReconciliationSourceError);
    for (const field of ["organizationId", "locationId", "itemId", "stocktakeId"] as const)
      expect(() => stocktakeReconciliation({ ...f, movement: { ...movement, [field]: randomUUID() } })).toThrow(ReconciliationSourceError);
    for (const changed of [{ revision: "3" }, { quantityDelta: "-1" }, { stocktakeId: null }])
      expect(() => stocktakeReconciliation({ ...f, movement: { ...movement, ...changed } })).toThrow(ReconciliationSourceError);
    expect(() => stocktakeReconciliation({ ...fixture("5", "5"), movement })).toThrow(ReconciliationSourceError);
  });
  it("rejects missing reason, invalid revisions and malformed, fractional or overflowing physical counts", () => {
    const f = fixture();
    expect(() => stocktakeReconciliation({ ...f, reason: " " })).toThrow(ReconciliationSourceError);
    for (const changed of [{ revision: "1" }, { revision: "3" }, { expectedRevision: "-1" }, { countedQuantity: "3.5" },
      { countedQuantity: "-1" }, { countedQuantity: "9223372036854775808" }, { expectedQuantity: "05" }])
      expect(() => stocktakeReconciliation({ ...f, observation: { ...f.observation, ...changed } })).toThrow();
  });
  it("retains explicit unit identity and changes zero evidence when its original observation changes", () => {
    const f = fixture("0", "0"), original = stocktakeReconciliation(f);
    expect(stocktakeReconciliation({ ...f, unit: null }).plan.unit).toBe("QUANTITY");
    expect(stocktakeReconciliation({ ...f, unit: "boxes" }).plan.evidence[0].fingerprint).not.toBe(original.plan.evidence[0].fingerprint);
    expect(stocktakeReconciliation({ ...f, observation: { ...f.observation, id: randomUUID() } }).plan.evidence[0].fingerprint).not.toBe(original.plan.evidence[0].fingerprint);
    expect(() => stocktakeReconciliation({ ...f, unit: " " })).toThrow(ReconciliationSourceError);
    expect(stocktakeReconciliation(f)).toEqual(original);
  });
});
