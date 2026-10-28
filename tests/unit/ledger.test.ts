import { describe, expect, it } from "vitest";
import { assertBalancedPostings } from "@/platform/ledger/ledger";
import { Money } from "@/platform/money/money";
import Decimal from "decimal.js";
import fc from "fast-check";
import type { LedgerPostingDraft } from "@/platform/ledger/ledger";

const fromCents = (cents: bigint) => {
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

describe("ledger invariants", () => {
  it.each([200, 500])("retains exact balance for %i maximum-sized postings on each side in either order", count => {
    const debit: LedgerPostingDraft = { side: "DEBIT", amount: Money.of("9999999999999999.99", "MAD") };
    const credit: LedgerPostingDraft = { ...debit, side: "CREDIT" };
    const rows = [...Array<LedgerPostingDraft>(count).fill(debit), ...Array<LedgerPostingDraft>(count).fill(credit)];
    expect(() => assertBalancedPostings(rows)).not.toThrow();
    expect(() => assertBalancedPostings(rows.toReversed())).not.toThrow();
  });

  it("agrees with an independent integer oracle for large multi-currency journals and one-cent errors", () => {
    const precision = Decimal.precision;
    fc.assert(fc.property(fc.array(fc.bigInt({ min: 900000000000000000n, max: 999999999999999999n }), { minLength: 150, maxLength: 500 }), amounts => {
      const debits: LedgerPostingDraft[] = amounts.map((cents, index) => ({ side: "DEBIT", amount: Money.of(fromCents(cents), index % 2 ? "MAD" : "EUR") }));
      const credits: LedgerPostingDraft[] = debits.map(row => ({ ...row, side: "CREDIT" }));
      const journal = [...debits, ...credits.toReversed()];
      const oracle = new Map<string, bigint>();
      for (const row of journal) {
        const cents = BigInt(row.amount.toJSON().amount.replace(".", ""));
        oracle.set(row.amount.currency, (oracle.get(row.amount.currency) ?? 0n) + (row.side === "DEBIT" ? cents : -cents));
      }
      expect([...oracle.values()]).toEqual([0n, 0n]);
      expect(() => assertBalancedPostings(journal)).not.toThrow();
      const corrupt = journal.map((row, index) => index === journal.length - 1 ? { ...row, amount: Money.of(fromCents(amounts[0] - 1n), row.amount.currency) } : row);
      expect(() => assertBalancedPostings(corrupt)).toThrow("Ledger transaction is not balanced for EUR");
    }), { numRuns: 250, endOnFailure: true });
    expect(Decimal.precision).toBe(precision);
  });

  it("does not cancel equal opposite one-cent errors across currencies", () => {
    expect(() => assertBalancedPostings([
      { side: "DEBIT", amount: Money.of("9999999999999999.99", "MAD") },
      { side: "CREDIT", amount: Money.of("9999999999999999.98", "MAD") },
      { side: "DEBIT", amount: Money.of("9999999999999999.98", "EUR") },
      { side: "CREDIT", amount: Money.of("9999999999999999.99", "EUR") }
    ])).toThrow("Ledger transaction is not balanced for MAD");
  });

  it("accepts debit and credit postings that balance per currency", () => {
    expect(() =>
      assertBalancedPostings([
        { side: "DEBIT", amount: Money.of("8000.00", "MAD") },
        { side: "CREDIT", amount: Money.of("8000.00", "MAD") },
        { side: "DEBIT", amount: Money.of("100.00", "EUR") },
        { side: "CREDIT", amount: Money.of("100.00", "EUR") }
      ])
    ).not.toThrow();
  });

  it("rejects transactions with fewer than two postings", () => {
    expect(() =>
      assertBalancedPostings([{ side: "DEBIT", amount: Money.of("1.00", "MAD") }])
    ).toThrow("at least two postings");
  });

  it("rejects unbalanced postings per currency", () => {
    expect(() =>
      assertBalancedPostings([
        { side: "DEBIT", amount: Money.of("8000.00", "MAD") },
        { side: "CREDIT", amount: Money.of("7999.99", "MAD") }
      ])
    ).toThrow("Ledger transaction is not balanced for MAD");
  });
});
