import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOwnerStatement, type RawOwnerLedgerPosting } from "@/platform/ledger/owner-statement";
import { companyLedgerTotals } from "@/modules/finance/domain/company-ledger";

const posting: RawOwnerLedgerPosting = { id: randomUUID(), transactionId: randomUUID(), reference: "Original EUR financial source", occurredAt: new Date("2032-05-02T12:00:00Z"),
  description: null, side: "CREDIT", amount: "9007199254740993.07", currency: "EUR", bucket: "OWNER_REVENUE", dimensions: {}, locationName: "Original EUR account", locationCode: "ORIGINAL_EUR" };
const statement = { organizationId: randomUUID(), ownerId: randomUUID(), ownerName: "Native currency owner", propertyId: randomUUID(), propertyName: "Native currency villa",
  periodStart: new Date("2032-05-01T00:00:00Z"), periodEnd: new Date("2032-06-01T00:00:00Z"), postings: [posting] };
const account = { id: randomUUID(), code: "ACTUAL_COMPANY_REVENUE", name: "Original EUR company revenue", currency: "EUR", opening: "9007199254740993.07", credits: "0.01", debits: "0.00", count: "1" };

describe("explicit financial currency boundaries", () => {
  it("rejects an owner statement whose sole native currency differs from the selected currency", () => {
    expect(() => buildOwnerStatement({ ...statement, currency: "MAD" })).toThrow(/currenc/i);
  });
  it("preserves the selected non-base currency and exact original cents", () => {
    const result = buildOwnerStatement({ ...statement, currency: "EUR" });
    expect(result.currency).toBe("EUR"); expect(result.closingBalance.toJSON()).toEqual({ amount: "9007199254740993.07", currency: "EUR" });
    expect(result.lines[0].amount.toJSON()).toEqual({ amount: posting.amount, currency: posting.currency });
    expect(companyLedgerTotals([account], "EUR").closingBalance).toBe("9007199254740993.08");
  });
  it("rejects company account totals from a different native currency instead of relabelling them", () => {
    expect(() => companyLedgerTotals([account], "MAD")).toThrow(/mix|currenc/i);
  });
});
