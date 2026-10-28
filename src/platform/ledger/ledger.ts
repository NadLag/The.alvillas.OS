import { Money } from "@/platform/money/money";

export type LedgerSide = "DEBIT" | "CREDIT";

export type LedgerPostingDraft = {
  side: LedgerSide;
  amount: Money;
};

export function assertBalancedPostings(postings: readonly LedgerPostingDraft[]): void {
  if (postings.length < 2) {
    throw new Error("A ledger transaction must have at least two postings");
  }

  const balances = new Map<string, Money>();

  for (const posting of postings) {
    const current = balances.get(posting.amount.currency) ?? Money.zero(posting.amount.currency);
    balances.set(posting.amount.currency, posting.side === "DEBIT"
      ? current.add(posting.amount)
      : current.subtract(posting.amount));
  }

  for (const [currency, balance] of balances) {
    if (!balance.equals(Money.zero(currency))) {
      throw new Error(`Ledger transaction is not balanced for ${currency}`);
    }
  }
}
