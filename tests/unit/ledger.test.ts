import { describe, expect, it } from "vitest";
import { assertBalancedPostings } from "@/platform/ledger/ledger";
import { Money } from "@/platform/money/money";

describe("ledger invariants", () => {
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
