import { describe, expect, it } from "vitest";
import { fieldCashPayloadSchema } from "@/platform/ledger/field-cash";
import { cashCollectionPostings, cashCollectionRevision } from "@/modules/finance/domain/cash-custody";
import { Money } from "@/platform/money/money";

const revision = cashCollectionRevision("task", 1, 0n);
const payload = { taskId: "019a0000-0000-7000-8000-000000000001", amount: "500.25", currency: "MAD", payer: "Guest", purpose: "Transfer", expectedRevision: revision };
describe("field cash capture uses the prescribed custody journal", () => {
  it("accepts exact positive money and rejects forged provenance or invalid amounts", () => {
    expect(fieldCashPayloadSchema.parse(payload)).toEqual(payload);
    for (const amount of ["0", "-1", "1.001", "1e3", "Infinity", "1,00", "10000000000000000"])
      expect(fieldCashPayloadSchema.safeParse({ ...payload, amount }).success).toBe(false);
    for (const forged of [{ collectorPersonId: payload.taskId }, { propertyId: payload.taskId }, { receivedAccountId: payload.taskId }])
      expect(fieldCashPayloadSchema.safeParse({ ...payload, ...forged }).success).toBe(false);
  });
  it("changes the critical revision for another receipt or task context without using client clocks", () => {
    expect(revision).toHaveLength(43);
    expect(cashCollectionRevision("task", 1, 0n)).toBe(revision);
    expect(cashCollectionRevision("task", 1, 1n)).not.toBe(revision);
    expect(cashCollectionRevision("task", 2, 0n)).not.toBe(revision);
    expect(cashCollectionRevision("other-task", 1, 0n)).not.toBe(revision);
  });
  it("debits custody and credits unallocated collections with no revenue or ownership allocation", () => {
    const dimensions = { propertyId: "property", taskId: "task", collectorPersonId: "person" };
    const postings = cashCollectionPostings({ amount: Money.of("9007199254740991.99", "EUR"), custodyAccountId: "custody", unallocatedAccountId: "unallocated", dimensions });
    expect(postings.map(row => ({ account: row.ledgerAccountId, side: row.side, amount: row.amount.toJSON(), bucket: row.bucket }))).toEqual([
      { account: "custody", side: "DEBIT", amount: { amount: "9007199254740991.99", currency: "EUR" }, bucket: "CASH_COLLECTION" },
      { account: "unallocated", side: "CREDIT", amount: { amount: "9007199254740991.99", currency: "EUR" }, bucket: "UNALLOCATED_COLLECTION" }
    ]);
    expect(postings.every(row => row.dimensions === dimensions)).toBe(true);
    expect(() => cashCollectionPostings({ amount: Money.zero("MAD"), custodyAccountId: "custody", unallocatedAccountId: "unallocated", dimensions })).toThrow();
    expect(() => cashCollectionPostings({ amount: Money.of("1", "MAD"), custodyAccountId: "same", unallocatedAccountId: "same", dimensions })).toThrow();
  });
});
