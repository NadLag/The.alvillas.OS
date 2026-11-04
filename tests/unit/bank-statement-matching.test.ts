import { describe, expect, it } from "vitest";
import { bankStatementMatchSuggestions, type BankMatchCandidate, type BankMatchSource } from "@/modules/finance/domain/bank-statement-matching";
import type { BankStatementPolicy } from "@/platform/config/bank-statement-policy";

const source: BankMatchSource = { accountId: "actual-bank", postedDate: "2026-11-03", amount: { amount: "9999999999999999.99", currency: "MAD" }, reference: "Original-1" };
const candidate = (id: string, changes: Partial<BankMatchCandidate> = {}): BankMatchCandidate => ({ ...source, postingId: id, transactionId: "journal-" + id, ...changes });
const rule: BankStatementPolicy["matching"] = { date_window_days: 0, amount_tolerance: "0.00", reference: "EXACT", admission: "EXPLICIT_REVIEW", ledger_effect: "NONE" };
describe("original bank matching suggestions", () => {
  it("returns every ambiguous exact candidate without choosing or admitting one", () => {
    const input = [candidate("b"), candidate("a")], before = JSON.stringify(input);
    expect(bankStatementMatchSuggestions(source, input, rule).map(row => row.postingId)).toEqual(["a", "b"]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("keeps every cent of a large actual-minus-expected variance and requires a reason", () => {
    const candidates = [candidate("variance", { amount: { amount: "9999999999999999.98", currency: "MAD" } }), candidate("exact")];
    expect(bankStatementMatchSuggestions(source, candidates, rule).map(row => row.postingId)).toEqual(["exact"]);
    const rows = bankStatementMatchSuggestions(source, candidates, { ...rule, amount_tolerance: "0.01" });
    expect(rows.map(row => row.postingId)).toEqual(["exact", "variance"]);
    expect(rows[1]).toMatchObject({ expected: { amount: "9999999999999999.98", currency: "MAD" }, actual: source.amount, variance: { amount: "0.01", currency: "MAD" }, requiresVarianceReason: true });
  });
  it("never crosses actual bank accounts, currencies or amount signs even with broad tolerance", () => {
    const actual = { ...source, amount: { amount: "0.01", currency: "MAD" } };
    const candidates = [candidate("foreign-account", { accountId: "another-bank", amount: actual.amount }), candidate("foreign-currency", { amount: { amount: "0.01", currency: "EUR" } }), candidate("opposite", { amount: { amount: "-0.01", currency: "MAD" } })];
    expect(bankStatementMatchSuggestions(actual, candidates, { ...rule, amount_tolerance: "100.00" })).toEqual([]);
  });
  it("uses explicit reference and date rules across month boundaries", () => {
    const candidates = [candidate("earlier", { postedDate: "2026-10-31", reference: "original-1" })];
    expect(bankStatementMatchSuggestions(source, candidates, { ...rule, date_window_days: 3 })).toEqual([]);
    expect(bankStatementMatchSuggestions(source, candidates, { ...rule, date_window_days: 3, reference: "CASE_INSENSITIVE" })[0].dateDistanceDays).toBe(3);
    expect(bankStatementMatchSuggestions(source, candidates, { ...rule, date_window_days: 2, reference: "NONE" })).toEqual([]);
  });
  it("does not interpret absent references as an exact match", () => {
    const actual = { ...source, reference: null }, rows = [candidate("original", { reference: null })];
    expect(bankStatementMatchSuggestions(actual, rows, rule)).toEqual([]);
    expect(bankStatementMatchSuggestions(actual, rows, { ...rule, reference: "NONE" })).toHaveLength(1);
  });
  it("rejects repeated native candidate identities and preserves exact negative variances", () => {
    expect(() => bankStatementMatchSuggestions(source, [candidate("one"), candidate("one")], rule)).toThrow("duplicate_bank_match_candidate");
    const actual = { ...source, amount: { amount: "-0.02", currency: "MAD" } };
    expect(bankStatementMatchSuggestions(actual, [candidate("one", { amount: { amount: "-0.01", currency: "MAD" } })], { ...rule, amount_tolerance: "0.01" })[0].variance.amount).toBe("-0.01");
  });
  it("rejects excess source, native candidate and tolerance precision instead of rounding it into a match", () => {
    expect(() => bankStatementMatchSuggestions({ ...source, amount: { amount: "0.001", currency: "MAD" } }, [], rule)).toThrow();
    expect(() => bankStatementMatchSuggestions(source, [candidate("inexact", { amount: { amount: "0.001", currency: "MAD" } })], rule)).toThrow();
    expect(() => bankStatementMatchSuggestions(source, [], { ...rule, amount_tolerance: "0.001" })).toThrow();
  });
});
