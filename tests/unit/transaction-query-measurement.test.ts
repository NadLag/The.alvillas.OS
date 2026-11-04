import { describe, expect, it } from "vitest";
import { transactionQueryMeasurement } from "../integration/support/transaction-query-measurement";

function fixture() {
  const measurement = transactionQueryMeasurement({ $queryRawUnsafe: async sql => { await new Promise<void>(resolve => setImmediate(resolve)); measurement.observe(sql); return []; } });
  return measurement;
}
describe("causal transaction query measurement", () => {
  it("waits for delayed commit evidence and counts every query inside the original transaction", async () => {
    const measurement = fixture();
    const result = await measurement.measure(() => {
      measurement.observe("SELECT 1"); measurement.observe("BEGIN"); measurement.observe("SELECT original_source FROM native_source");
      setImmediate(() => measurement.observe("COMMIT")); return Promise.resolve("original-result");
    });
    expect(result).toEqual({ value: "original-result", queries: ["BEGIN", "SELECT original_source FROM native_source", "COMMIT"], count: 3, poolProbes: 1 });
  });
  it("keeps strict constant-query detection sensitive to an additional application query", async () => {
    const measurement = fixture(), counts: number[] = [];
    for (const extra of [false, true]) {
      const result = await measurement.measure(() => {
        measurement.observe("BEGIN"); measurement.observe("SELECT original_source FROM native_source"); if (extra) measurement.observe("SELECT extra_source FROM native_source"); measurement.observe("COMMIT"); return Promise.resolve();
      }); counts.push(result.count);
    }
    expect(counts).toEqual([3, 4]); expect(new Set(counts).size).toBe(2);
  });
  it("rejects an application query outside the measured transaction instead of silently excluding it", async () => {
    const measurement = fixture();
    await expect(measurement.measure(() => {
      measurement.observe("SELECT private_source FROM native_source"); measurement.observe("BEGIN"); measurement.observe("SELECT original_source FROM native_source"); measurement.observe("COMMIT"); return Promise.resolve();
    })).rejects.toThrow("One complete isolated transaction");
  });
  it("rejects multiple transactions and rolled-back reads", async () => {
    for (const queries of [["BEGIN", "COMMIT", "BEGIN", "COMMIT"], ["BEGIN", "ROLLBACK"]]) {
      const measurement = fixture();
      await expect(measurement.measure(() => { queries.forEach(measurement.observe); return Promise.resolve(); })).rejects.toThrow("One complete isolated transaction");
    }
  });
});
