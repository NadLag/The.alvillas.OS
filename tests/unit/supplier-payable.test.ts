import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { allocateConfiguredExpense } from "@/modules/finance/domain/configured-finance-rules";
import { supplierInvoicePostings, supplierPaymentPostings, supplierOutstanding, type SupplierInvoicePostingLine } from "@/modules/finance/domain/supplier-payable";

const amount = (value: string, currency = "MAD") => Money.of(value, currency);
const funding = { id: "bank", code: "BANK_TEST", accountType: "ASSET_LOCATION", normalSide: "DEBIT", archivedAt: null };
function line(value = "2400.00", treatment = "OWNER_PAID"): SupplierInvoicePostingLine {
  const total = amount(value), allocation = allocateConfiguredExpense({ default_treatment: treatment }, { amount: total, category: "maintenance" });
  return { id: "line", propertyId: "property", amount: total, category: "maintenance", allocation,
    owners: [{ ownerId: "owner", ownerName: "Owner", shareBps: 10000 }], ownerAmounts: [{ ownerId: "owner", amount: allocation.ownerAmount }],
    ownerAccounts: new Map([["owner", "owner-claim"]]), companyExpenseAccountId: "company-expense", guestReceivableAccountId: "guest-receivable" };
}
const invoice = (lines = [line()]) => supplierInvoicePostings({ invoiceId: "invoice", supplierId: "supplier", liabilityAccountId: "supplier-claim", amount: lines.reduce((total, row) => total.add(row.amount), amount("0")), lines });
const payment = (value: string, outstanding = "2400.00") => supplierPaymentPostings({ invoiceId: "invoice", supplierId: "supplier", paymentId: "payment", liabilityAccountId: "supplier-claim", amount: amount(value), outstanding: amount(outstanding), funding });

describe("supplier payable posting recipes", () => {
  it("recognizes the handbook 2400 owner invoice as a claim and settles it without booking another expense", () => {
    const recognized = invoice();
    expect(recognized.map(row => [row.ledgerAccountId, row.side, row.amount.toJSON().amount, row.bucket])).toEqual([
      ["owner-claim", "DEBIT", "2400.00", "OWNER_EXPENSE"], ["supplier-claim", "CREDIT", "2400.00", "SUPPLIER_INVOICE"]
    ]);
    expect(recognized[0].dimensions).toMatchObject({ owner_id: "owner", property_id: "property", supplier_id: "supplier", supplier_invoice_id: "invoice", supplier_invoice_line_id: "line", category: "maintenance" });
    const paid = payment("2000.00");
    expect(paid.map(row => [row.ledgerAccountId, row.side, row.amount.toJSON().amount])).toEqual([["supplier-claim", "DEBIT", "2000.00"], ["bank", "CREDIT", "2000.00"]]);
    expect(supplierOutstanding("MAD", [...recognized, ...paid].filter(row => row.ledgerAccountId === "supplier-claim")).toJSON().amount).toBe("400.00");
    const final = payment("400.00", "400.00");
    const movements = [...recognized, ...paid, ...final].filter(row => row.ledgerAccountId === "supplier-claim");
    expect(supplierOutstanding("MAD", movements).toJSON().amount).toBe("0.00");
    expect(supplierOutstanding("MAD", [...movements, { ...final[0], side: "CREDIT" }]).toJSON().amount).toBe("400.00");
  });

  it("supports a company cost center without requiring a property or exposing an owner claim", () => {
    const source = { ...line("920.00", "ALVILLAS_PAID"), propertyId: null, costCenter: "office", owners: [], ownerAmounts: [] };
    const rows = invoice([source]);
    expect(rows.map(row => row.ledgerAccountId)).toEqual(["company-expense", "supplier-claim"]);
    expect(rows[0].dimensions).toMatchObject({ cost_center: "office", supplier_id: "supplier" });
    expect(rows[0].dimensions).not.toHaveProperty("property_id"); expect(rows[0].dimensions).not.toHaveProperty("owner_id");
  });

  it("retains each configured property's allocation and source category on one supplier invoice", () => {
    const rows = invoice([line(), { ...line("920.00", "ALVILLAS_PAID"), id: "line-b", propertyId: "property-b", category: "laundry" }]);
    expect(rows.filter(row => row.side === "CREDIT").map(row => row.amount.toJSON().amount)).toEqual(["2400.00", "920.00"]);
    expect(rows[2].dimensions).toMatchObject({ property_id: "property-b", supplier_invoice_line_id: "line-b", category: "laundry" });
  });

  it("rejects duplicate lines, non-conserving totals, missing source scopes and mixed currencies", () => {
    expect(() => invoice([line(), line()])).toThrow(/distinct/u);
    expect(() => supplierInvoicePostings({ invoiceId: "invoice", supplierId: "supplier", liabilityAccountId: "supplier-claim", amount: amount("2400.01"), lines: [line()] })).toThrow(/conserve/u);
    expect(() => invoice([{ ...line(), propertyId: null }])).toThrow(/property source/u);
    expect(() => invoice([{ ...line("10", "GUEST_PAID"), reservationId: null }])).toThrow(/reservation source/u);
    expect(() => invoice([{ ...line(), amount: amount("2400", "EUR") }])).toThrow(/Cannot mix/u);
    expect(() => supplierInvoicePostings({ invoiceId: "invoice", supplierId: "supplier", liabilityAccountId: "supplier-claim", amount: amount("0"), lines: [] })).toThrow(/positive/u);
  });

  it("rejects overpayment, invalid physical funding, mixed currencies and claim/location aliasing", () => {
    for (const value of ["0", "-0.01", "2400.01"]) expect(() => payment(value)).toThrow(/positive outstanding/u);
    for (const source of [{ ...funding, archivedAt: new Date() }, { ...funding, code: "CASH_CUSTODY_PRIVATE" }, { ...funding, accountType: "CLAIM_OWNERSHIP" }, { ...funding, id: "supplier-claim" }]) {
      expect(() => supplierPaymentPostings({ invoiceId: "invoice", supplierId: "supplier", paymentId: "payment", liabilityAccountId: "supplier-claim", amount: amount("1"), outstanding: amount("2"), funding: source })).toThrow(/physical funding/u);
    }
    expect(() => supplierPaymentPostings({ invoiceId: "invoice", supplierId: "supplier", paymentId: "payment", liabilityAccountId: "supplier-claim", amount: amount("1", "EUR"), outstanding: amount("2"), funding })).toThrow(/one currency/u);
  });

  it("retains exact partial-settlement cents and a 500-invoice aggregate using an integer oracle", () => {
    fc.assert(fc.property(fc.bigInt({ min: 2n, max: 999999999999999999n }), fc.integer({ min: 1, max: 9999 }), (cents, fraction) => {
      const text = (value: bigint) => { const digits = value.toString().padStart(3, "0"); return `${digits.slice(0, -2)}.${digits.slice(-2)}`; };
      const paid = cents * BigInt(fraction) / 10000n;
      if (paid === 0n) return;
      const claim = supplierOutstanding("MAD", [{ side: "CREDIT", amount: amount(text(cents)) }, { side: "DEBIT", amount: amount(text(paid)) }]);
      expect(claim.toJSON().amount).toBe(text(cents - paid));
      const posted = payment(text(paid), text(cents));
      expect(posted[0].amount.toJSON().amount).toBe(text(paid));
    }), { numRuns: 300 });
    expect(supplierOutstanding("MAD", Array.from({ length: 500 }, () => ({ side: "CREDIT", amount: amount("9999999999999999.99") }))).toJSON().amount).toBe("4999999999999999995.00");
    expect(() => supplierOutstanding("EUR", [{ side: "CREDIT", amount: amount("1") }])).toThrow(/Cannot mix/u);
  });
});
