import Decimal from "decimal.js";
import type { Money } from "@/platform/money/money";

export type LedgerSide = "DEBIT" | "CREDIT";

export type LedgerPostingDraft = {
  side: LedgerSide;
  amount: Money;
};

export function assertBalancedPostings(postings: readonly LedgerPostingDraft[]): void {
  if (postings.length < 2) {
    throw new Error("A ledger transaction must have at least two postings");
  }

  const balances = new Map<string, Decimal>();

  for (const posting of postings) {
    const signedAmount =
      posting.side === "DEBIT" ? posting.amount.amount : posting.amount.amount.negated();
    const current = balances.get(posting.amount.currency) ?? new Decimal(0);
    balances.set(posting.amount.currency, current.plus(signedAmount));
  }

  for (const [currency, balance] of balances) {
    if (!balance.eq(0)) {
      throw new Error(`Ledger transaction is not balanced for ${currency}`);
    }
  }
}
