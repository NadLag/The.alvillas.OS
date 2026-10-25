import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countedStockQuantitySchema, decideStocktake, StocktakeConflictError, stockQuantitySchema, stockRevisionSchema } from "@/modules/inventory/domain/stocktake";

describe("exact stocktake decisions", () => {
  it("retains count and adjustment precision above JavaScript's integer range", () => {
    const current = { quantity: "9007199254740993", revision: "8" };
    expect(decideStocktake({ expected: current, current, countedQuantity: "9007199254740995", configuredMinimum: "9007199254740996" }))
      .toEqual({ quantity: "9007199254740995", delta: "2", variance: true, belowMinimum: true });
  });
  it("derives each resulting stock count from its prior quantity and appended movement", () => {
    fc.assert(fc.property(fc.bigInt({ min: -9_223_372_036_854_775_807n, max: 9_223_372_036_854_775_807n }),
      fc.bigInt({ min: 0n, max: 9_223_372_036_854_775_807n }), (prior, counted) => {
        const current = { quantity: prior.toString(), revision: "4" };
        const result = decideStocktake({ expected: current, current, countedQuantity: counted.toString(), configuredMinimum: null });
        expect(prior + BigInt(result.delta)).toBe(counted);
        expect(result.variance).toBe(prior !== counted);
      }));
  });
  it("requires explicit review when another count has advanced the revision", () => {
    expect(() => decideStocktake({ expected: { quantity: "12", revision: "1" }, current: { quantity: "12", revision: "2" },
      countedQuantity: "10", configuredMinimum: null })).toThrow(StocktakeConflictError);
  });
  it("rejects a forged expected quantity even when its revision matches", () => {
    expect(() => decideStocktake({ expected: { quantity: "11", revision: "2" }, current: { quantity: "12", revision: "2" },
      countedQuantity: "10", configuredMinimum: null })).toThrow(StocktakeConflictError);
  });
  it("uses only an explicit configured minimum, including an explicit zero", () => {
    const current = { quantity: "12", revision: "2" };
    for (const minimum of [null, "0", "10"]) expect(decideStocktake({ expected: current, current, countedQuantity: "10", configuredMinimum: minimum }).belowMinimum).toBe(false);
    expect(decideStocktake({ expected: current, current, countedQuantity: "10", configuredMinimum: "11" }).belowMinimum).toBe(true);
  });
  it("records an unchanged observation without inventing a physical movement", () => {
    const current = { quantity: "12", revision: "2" };
    expect(decideStocktake({ expected: current, current, countedQuantity: "12", configuredMinimum: null }))
      .toEqual({ quantity: "12", delta: "0", variance: false, belowMinimum: false });
  });
  it("accepts signed derived stock but validates physical counts as canonical nonnegative integers", () => {
    expect(stockQuantitySchema.parse("-4")).toBe("-4");
    expect(countedStockQuantitySchema.parse("9223372036854775807")).toBe("9223372036854775807");
    for (const value of [12, -1, "-1", "-0", "01", "1.5", "1e3", "9223372036854775808"]) expect(countedStockQuantitySchema.safeParse(value).success).toBe(false);
  });
  it("rejects line-terminated and whitespace-bearing count, quantity and revision encodings", () => {
    for (const schema of [stockQuantitySchema, countedStockQuantitySchema, stockRevisionSchema]) {
      for (const value of ["12\n", "12\r", "12\u2028", "12\u2029", " 12", "12 "]) expect(schema.safeParse(value).success).toBe(false);
    }
  });
});
