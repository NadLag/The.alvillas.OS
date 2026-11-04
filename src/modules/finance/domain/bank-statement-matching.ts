import { Temporal } from "temporal-polyfill";
import { bankStatementAmount } from "./bank-statement-amount";
import type { BankStatementPolicy } from "@/platform/config/bank-statement-policy";

export type BankMatchSource = { accountId: string; postedDate: string; amount: { amount: string; currency: string }; reference: string | null };
export type BankMatchCandidate = BankMatchSource & { postingId: string; transactionId: string };
export type BankMatchSuggestion = {
  postingId: string;
  transactionId: string;
  expected: { amount: string; currency: string };
  actual: { amount: string; currency: string };
  variance: { amount: string; currency: string };
  dateDistanceDays: number;
  referenceMatches: boolean;
  requiresVarianceReason: boolean;
};

/** Suggestions operate on independently authorized source candidates. They never admit matches or write money. */
export function bankStatementMatchSuggestions(source: BankMatchSource, candidates: readonly BankMatchCandidate[], rule: BankStatementPolicy["matching"]): BankMatchSuggestion[] {
  const exact = (amount: string, currency: string) => bankStatementAmount(amount, currency, { decimalSeparator: ".", groupingSeparator: "", minorUnits: 2 });
  const actual = exact(source.amount.amount, source.amount.currency), tolerance = exact(rule.amount_tolerance, actual.currency);
  if (tolerance.amount.isNegative()) throw new Error("invalid_bank_matching_tolerance");
  const day = Temporal.PlainDate.from(source.postedDate);
  const sameReference = (reference: string | null) => !!source.reference && !!reference && (rule.reference === "CASE_INSENSITIVE" ? source.reference.toUpperCase() === reference.toUpperCase() : source.reference === reference);
  const ids = new Set<string>();
  return candidates.flatMap(candidate => {
    if (ids.has(candidate.postingId)) throw new Error("duplicate_bank_match_candidate");
    ids.add(candidate.postingId);
    if (candidate.accountId !== source.accountId || candidate.amount.currency !== actual.currency) return [];
    const dateDistanceDays = Math.abs(day.until(Temporal.PlainDate.from(candidate.postedDate), { largestUnit: "day" }).days);
    if (dateDistanceDays > rule.date_window_days) return [];
    const referenceMatches = sameReference(candidate.reference);
    if (rule.reference !== "NONE" && !referenceMatches) return [];
    const expected = exact(candidate.amount.amount, actual.currency), variance = actual.subtract(expected);
    if (variance.amount.abs().gt(tolerance.amount) || (actual.amount.isPositive() && expected.amount.isNegative()) ||
        (actual.amount.isNegative() && expected.amount.isPositive())) return [];
    return [{ postingId: candidate.postingId, transactionId: candidate.transactionId, expected: expected.toJSON(), actual: actual.toJSON(),
      variance: variance.toJSON(), dateDistanceDays, referenceMatches, requiresVarianceReason: !variance.amount.isZero() }];
  }).sort((left, right) => Number(left.requiresVarianceReason) - Number(right.requiresVarianceReason) ||
    Number(right.referenceMatches) - Number(left.referenceMatches) || left.dateDistanceDays - right.dateDistanceDays || left.postingId.localeCompare(right.postingId));
}
