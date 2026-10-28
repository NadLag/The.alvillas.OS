import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { companyLedgerFilters, companyLedgerTotals, type CompanyLedgerAccountTotals } from "@/modules/finance/domain/company-ledger";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";

const amount = (cents: bigint) => `${cents < 0n ? "-" : ""}${(cents < 0n ? -cents : cents).toString().padStart(3, "0").slice(0, -2)}.${(cents < 0n ? -cents : cents).toString().padStart(3, "0").slice(-2)}`;
const row = (opening = "0", credits = "0", debits = "0"): CompanyLedgerAccountTotals => ({ id: "company", code: "ALVILLAS_OWN", name: "Company", opening, credits, debits, count: "1" });

describe("ALVILLAS company net position", () => {
  it("retains actual Arabic letters and French diacritics in the localized ledger copy", () => {
    for (const text of [...Object.values(ar.CompanyLedger), ar.AppShell.companyLedger]) expect(text).toMatch(/\p{Script=Arabic}/u);
    expect(fr.CompanyLedger.description).toMatch(/\p{Letter}é|é\p{Letter}/u);
    for (const text of [...Object.values(ar.CompanyLedger), ...Object.values(fr.CompanyLedger)]) expect(text).not.toMatch(/\?\?|\uFFFD/u);
  });
  it("keeps company revenue and expense account signs, including reversals", () => {
    expect(companyLedgerTotals([row("8000", "1600", "0"), row("-200", "50", "300")], "MAD")).toMatchObject({
      openingBalance: "7800.00", periodCredits: "1650.00", periodDebits: "300.00", periodResult: "1350.00", closingBalance: "9150.00", rowCount: "2"
    });
  });
  it("has an exact empty state", () => {
    expect(companyLedgerTotals([], "EUR")).toEqual({ openingBalance: "0.00", periodCredits: "0.00", periodDebits: "0.00", periodResult: "0.00", closingBalance: "0.00", rowCount: "0", accounts: [] });
  });
  it("retains cents across 500 valid large account balances", () => {
    expect(companyLedgerTotals(Array.from({ length: 500 }, () => row("9999999999999999.99", "0.01", "0")), "MAD")).toMatchObject({
      openingBalance: "4999999999999999995.00", closingBalance: "5000000000000000000.00", rowCount: "500"
    });
  });
  it("ties opening plus credits minus debits to closing against an integer-cent oracle", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.bigInt({ min: -999999999999999999n, max: 999999999999999999n }),
      fc.bigInt({ min: 0n, max: 999999999999999999n }), fc.bigInt({ min: 0n, max: 999999999999999999n })), { maxLength: 500 }), values => {
      const expected = values.reduce((net, [opening, credits, debits]) => net + opening + credits - debits, 0n);
      expect(companyLedgerTotals(values.map(([opening, credits, debits]) => row(amount(opening), amount(credits), amount(debits))), "MAD").closingBalance).toBe(amount(expected));
    }), { numRuns: 100 });
  });
  it.each([
    { fromOn: "2026-03-09", toOn: "2026-03-08" }, { fromOn: "2026-02-30" }, { currency: "mad" },
    { timezone: "Unknown/Zone" }, { ownerId: "a" }, { propertyId: "a" }, { after: "not-an-id" }
  ])("rejects malformed company-ledger filters %j", input => expect(companyLedgerFilters.safeParse(input).success).toBe(false));
});
