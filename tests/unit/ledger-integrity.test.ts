import { describe, expect, it } from "vitest";
import { ledgerIntegrityPolicySchema, LedgerIntegrityRebuild, type IntegrityMovement } from "@/modules/finance/domain/ledger-integrity";

const policy = () => ledgerIntegrityPolicySchema.parse({ run_at: "02:30", page_size: 50, max_findings: 10,
  account_types: { locations: ["ASSET_LOCATION", "STAFF_WALLET"], claims: ["CLAIM_OWNERSHIP"], company: ["ALVILLAS_OWN"] } });
const movement = (extra: Partial<IntegrityMovement> = {}): IntegrityMovement => ({ id: "posting", transactionId: "journal", accountId: "bank", currency: "MAD", amount: "0.07", side: "DEBIT", accountType: "ASSET_LOCATION", validScope: true, ...extra });

describe("independent nightly movement reconstruction", () => {
  it("keeps large exact native currencies separate and compares both accounts and journals", () => {
    const rebuild = new LedgerIntegrityRebuild(policy());
    for (const [currency, amount] of [["MAD", "0.07"], ["EUR", "9007199254740993.07"]]) {
      rebuild.add(movement({ currency, amount })); rebuild.add(movement({ id: "claim", accountId: "owner", currency, amount, side: "CREDIT", accountType: "CLAIM_OWNERSHIP" }));
    }
    rebuild.compareAccounts([...["MAD", "EUR"].flatMap(currency => {
      const amount = currency === "MAD" ? "0.07" : "9007199254740993.07";
      return [{ id: "bank", currency, debits: amount, credits: "0.00" }, { id: "owner", currency, debits: "0.00", credits: amount }];
    })]);
    rebuild.compareTransactions(["MAD", "EUR"].map(currency => ({ id: "journal", currency, debits: currency === "MAD" ? "0.07" : "9007199254740993.07", credits: currency === "MAD" ? "0.07" : "9007199254740993.07", postingCount: "2", sealed: true })));
    const report = rebuild.finish(); expect(report.passed).toBe(true); expect(report.movements).toBe("4"); expect(report.currencies).toEqual([
      { currency: "EUR", locations: "9007199254740993.07", claims: "9007199254740993.07", company: "0.00" }, { currency: "MAD", locations: "0.07", claims: "0.07", company: "0.00" }]);
  });
  it("detects a corrupted independent account total instead of accepting a balanced trial", () => {
    const rebuild = new LedgerIntegrityRebuild(policy()); rebuild.add(movement()); rebuild.add(movement({ accountId: "income", side: "CREDIT", accountType: "ALVILLAS_OWN" }));
    rebuild.compareAccounts([{ id: "bank", currency: "MAD", debits: "0.08", credits: "0.00" }, { id: "income", currency: "MAD", debits: "0.00", credits: "0.07" }]);
    expect(rebuild.finish().findings).toEqual([{ code: "ACCOUNT_BALANCE", sourceId: "bank", currency: "MAD" }]);
  });
  it("detects omitted and unexpected native account rows", () => {
    const rebuild = new LedgerIntegrityRebuild(policy()); rebuild.add(movement());
    rebuild.compareAccounts([{ id: "foreign", currency: "MAD", debits: "0.07", credits: "0.00" }]);
    expect(rebuild.finish().findings.filter(row => row.code === "ACCOUNT_BALANCE")).toHaveLength(2);
  });
  it("rejects unsealed, empty and individually unbalanced journals even when their combined balance is zero", () => {
    const rebuild = new LedgerIntegrityRebuild(policy()); rebuild.add(movement()); rebuild.add(movement({ transactionId: "other", accountId: "income", side: "CREDIT", accountType: "ALVILLAS_OWN" }));
    rebuild.compareTransactions([{ id: "journal", currency: "MAD", debits: "0.07", credits: "0.00", postingCount: "1", sealed: false },
      { id: "other", currency: "MAD", debits: "0.00", credits: "0.07", postingCount: "1", sealed: true }, { id: "empty", currency: null, debits: "0.00", credits: "0.00", postingCount: "0", sealed: true }]);
    expect(rebuild.finish().passed).toBe(false); expect(rebuild.finish().findings.some(row => row.code === "UNSEALED_TRANSACTION")).toBe(true);
  });
  it.each(["0.00", "-0.07", "0.071", "NaN"])("rejects invalid original money %s without rounding or repairing it", amount => {
    const rebuild = new LedgerIntegrityRebuild(policy()); rebuild.add(movement({ amount })); expect(rebuild.finish().findings[0].code).toBe("INVALID_MONEY");
  });
  it("keeps checking every movement after the retained finding limit is reached", () => {
    const configured = policy(); configured.max_findings = 1; const rebuild = new LedgerIntegrityRebuild(configured);
    for (let index = 0; index < 500; index++) rebuild.add(movement({ id: String(index), amount: "0.00" }));
    expect(rebuild.finish()).toMatchObject({ passed: false, movements: "500", failureCount: "500", findingsTruncated: true }); expect(rebuild.finish().findings).toHaveLength(1);
  });
  it("rejects foreign dimensions and an unclassified account instead of guessing ownership", () => {
    const rebuild = new LedgerIntegrityRebuild(policy()); rebuild.add(movement({ validScope: false, accountType: "UNKNOWN" }));
    expect(rebuild.finish().findings.map(row => row.code)).toContain("TENANT_DIMENSIONS"); expect(rebuild.finish().findings.map(row => row.code)).toContain("UNCLASSIFIED_ACCOUNT");
  });
  it("rejects overlapping configured account classifications", () => {
    const configured = policy(); configured.account_types.claims.push("ASSET_LOCATION"); expect(ledgerIntegrityPolicySchema.safeParse(configured).success).toBe(false);
  });
  it("cannot report success before comparing both independent native sources or append after finalization", () => {
    const rebuild = new LedgerIntegrityRebuild(policy()); rebuild.add(movement()); rebuild.add(movement({ accountId: "income", side: "CREDIT", accountType: "ALVILLAS_OWN" }));
    const first = rebuild.finish(); expect(first.passed).toBe(false); expect(first.findings[0].code).toBe("INCOMPLETE_CHECK");
    expect(rebuild.finish()).toEqual(first); expect(() => rebuild.add(movement())).toThrow("already complete");
  });
});
