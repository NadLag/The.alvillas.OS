import { describe, expect, it } from "vitest";
import { bankCsvMappingSchema, bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";

const csv = { delimiter: ";", dateFormat: "DD/MM/YYYY", decimalSeparator: ",", groupingSeparator: " ", columns: { postedDate: "date", transactionId: null, reference: null, description: "libelle", currency: null, amount: "montant" } };
const account = { account_code: "BANK_ORIGINAL", bank_id: "actual-bank", branch_id: null, account_id: "actual-account", account_type: "CHECKING", currency: "MAD", csv, ofx: true };
const policy = { source: "ORIGINAL_BANK_STATEMENT", accounts: [account], encoding: "UTF-8", max_bytes: 1000000, max_rows: 5000,
  matching: { date_window_days: 0, amount_tolerance: "0.00", reference: "EXACT", admission: "EXPLICIT_REVIEW", ledger_effect: "NONE" },
  source_corrections: "APPEND_AND_REOPEN_REVIEW", duplicate_csv_without_id: "RETAIN_EVERY_ROW" };
describe("explicit original bank statement policy", () => {
  it("accepts only a complete source policy without inventing a matching rule", () => {
    expect(bankStatementPolicySchema.parse(policy)).toEqual(policy);
    for (const key of Object.keys(policy)) { const incomplete = { ...policy }; delete incomplete[key as keyof typeof incomplete]; expect(bankStatementPolicySchema.safeParse(incomplete).success).toBe(false); }
  });
  it.each(["date_window_days", "amount_tolerance", "reference", "admission", "ledger_effect"])("requires explicit matching setting %s", key => {
    const matching: Record<string, unknown> = { ...policy.matching }; delete matching[key];
    expect(bankStatementPolicySchema.safeParse({ ...policy, matching }).success).toBe(false);
  });
  it("denies overlapping mappings and bank identities", () => {
    expect(bankCsvMappingSchema.safeParse({ ...csv, groupingSeparator: "," }).success).toBe(false);
    expect(bankCsvMappingSchema.safeParse({ ...csv, columns: { ...csv.columns, amount: "libelle" } }).success).toBe(false);
    expect(bankStatementPolicySchema.safeParse({ ...policy, accounts: [account, account] }).success).toBe(false);
    expect(bankStatementPolicySchema.safeParse({ ...policy, accounts: [account, { ...account, account_code: "ANOTHER_BANK" }] }).success).toBe(false);
  });
  it.each(["-0.01", "0.001", "1e2", 0.01])("denies inexact matching tolerance %s", amount_tolerance => {
    expect(bankStatementPolicySchema.safeParse({ ...policy, matching: { ...policy.matching, amount_tolerance } }).success).toBe(false);
  });
  it("rejects silent source deletion, automatic financial postings and duplicate erasure", () => {
    for (const value of [{ ...policy, source_corrections: "DELETE" }, { ...policy, duplicate_csv_without_id: "REMOVE" }, { ...policy, matching: { ...policy.matching, ledger_effect: "ADJUST_BALANCE" } }]) expect(bankStatementPolicySchema.safeParse(value).success).toBe(false);
  });
});
