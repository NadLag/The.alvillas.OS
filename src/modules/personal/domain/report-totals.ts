import { Money } from "@/platform/money/money";

export function totalsByCurrency(
  rows: readonly { kind: string; currency: string; amount: string }[],
  debit: readonly string[], credit: readonly string[]
) {
  const totals = new Map<string, Money>();
  for (const row of rows) {
    const positive = credit.includes(row.kind);
    if (!positive && !debit.includes(row.kind)) continue;
    const money = Money.of(row.amount, row.currency);
    const current = totals.get(row.currency) ?? Money.zero(row.currency);
    totals.set(row.currency, positive ? current.add(money) : current.subtract(money));
  }
  return [...totals.values()].map((money) => money.toJSON());
}
