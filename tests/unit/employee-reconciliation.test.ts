import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money } from "@/platform/money/money";
import { employeeReconciliation, type EmployeeReconciliationJournal } from "@/modules/finance/domain/employee-reconciliation";
import { ReconciliationSourceError } from "@/modules/finance/domain/reconciliation";

const money = (value: string, currency = "MAD") => Money.of(value, currency);
function fixture(earned = "0.07", paid = "0.03") {
  const organizationId = randomUUID(), claimId = randomUUID(), personId = randomUUID(), accountId = randomUUID();
  const journal = (bucket: string, value: string, side: "CREDIT" | "DEBIT", original: string | null = null): EmployeeReconciliationJournal => {
    const id = randomUUID(); return { id, organizationId, sealed: true, reversesTransactionId: original, postings: [{
      id: randomUUID(), organizationId, transactionId: id, ledgerAccountId: accountId, side, amount: money(value), bucket, claimId, personId,
      account: { code: "EMPLOYEE_PAYABLE", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" } }] };
  };
  const recognition = journal("EMPLOYEE_COMPENSATION", earned, "CREDIT"), payment = journal("EMPLOYEE_PAYMENT", paid, "DEBIT");
  return { input: { organizationId, claimId, personId, currency: "MAD", minorUnit: 2, recognitionJournalIds: [recognition.id],
    journals: [recognition, payment], outstanding: money(earned).subtract(money(paid)), actionJournalId: payment.id,
    reason: "Retain the original authorized employee payment" }, recognition, payment, journal };
}
describe("original native staff reconciliation", () => {
  it("keeps a partial payment's exact original earned and actual source facts with the remaining liability open", () => {
    const f = fixture(), before = JSON.stringify(f.input), result = employeeReconciliation(f.input);
    expect(result).toMatchObject({ provider: "STAFF", sourceType: "EMPLOYEE_CLAIM", sourceId: f.input.claimId, state: "OPEN_VARIANCE",
      plan: { unit: "MONEY:MAD", expected: "0.07", actual: "0.03", variance: "-0.04", reason: f.input.reason,
        varianceAction: `STAFF_SETTLEMENT:${f.payment.id}`, evidence: [] } });
    expect(result.plan.allocations.expected[0].sourceKey).toBe(f.recognition.postings[0].id);
    expect(result.plan.allocations.actual[0].sourceKey).toBe(f.payment.postings[0].id);
    expect(result.plan).not.toHaveProperty("classification"); expect(JSON.stringify(f.input)).toBe(before);
  });
  it("groups original payments and beneficiary offsets without recognizing costs again", () => {
    const f = fixture(), offset = f.journal("COMPENSATION_OFFSET", "0.04", "DEBIT");
    const result = employeeReconciliation({ ...f.input, journals: [...f.input.journals, offset], actionJournalId: offset.id, outstanding: money("0.00") });
    expect(result.state).toBe("MATCHED"); expect(result.plan).toMatchObject({ expected: "0.07", actual: "0.07", variance: "0.00", varianceAction: null });
    expect(result.plan.allocations.actual).toHaveLength(2); expect(result.plan.allocations.expected).toHaveLength(1);
  });
  it("retains actual original opposite journals and genuine zero net receipt without a synthetic source", () => {
    const f = fixture(), opposite = f.journal("EMPLOYEE_PAYMENT", "0.03", "CREDIT", f.payment.id);
    const result = employeeReconciliation({ ...f.input, journals: [...f.input.journals, opposite], actionJournalId: opposite.id, outstanding: money("0.07") });
    expect(result.plan).toMatchObject({ expected: "0.07", actual: "0.00", variance: "-0.07", evidence: [] });
    expect(result.plan.allocations.actual.map(row => row.original).sort()).toEqual(["-0.03", "0.03"]);
    expect(result.plan.allocations.actual.map(row => row.sourceKey).sort()).toEqual([f.payment.postings[0].id, opposite.postings[0].id].sort());
  });
  it("rejects cross-tenant, unsealed, duplicate, wrong-beneficiary and unrelated recognition evidence", () => {
    const f = fixture(), posting = f.payment.postings[0];
    for (const changed of [{ organizationId: randomUUID() }, { sealed: false }])
      expect(() => employeeReconciliation({ ...f.input, journals: [f.recognition, { ...f.payment, ...changed }] })).toThrow(ReconciliationSourceError);
    for (const changed of [{ organizationId: randomUUID() }, { transactionId: randomUUID() }, { claimId: randomUUID() }, { personId: randomUUID() },
      { bucket: "UNRELATED" }, { side: "CREDIT" }, { id: f.recognition.postings[0].id }])
      expect(() => employeeReconciliation({ ...f.input, journals: [f.recognition, { ...f.payment, postings: [{ ...posting, ...changed }] }] })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, journals: [...f.input.journals, f.payment] })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, recognitionJournalIds: [randomUUID()] })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, recognitionJournalIds: [f.recognition.id, f.recognition.id] })).toThrow(ReconciliationSourceError);
  });
  it("rejects missing, repeated or altered opposite journals and mismatched derived outstanding money", () => {
    const f = fixture(), opposite = f.journal("EMPLOYEE_PAYMENT", "0.03", "CREDIT", f.payment.id);
    const reversed = { ...f.input, journals: [...f.input.journals, opposite], actionJournalId: opposite.id, outstanding: money("0.07") };
    expect(() => employeeReconciliation({ ...reversed, journals: [f.recognition, opposite] })).toThrow(ReconciliationSourceError);
    const duplicate = f.journal("EMPLOYEE_PAYMENT", "0.03", "CREDIT", f.payment.id);
    expect(() => employeeReconciliation({ ...reversed, journals: [...reversed.journals, duplicate] })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...reversed, journals: [...f.input.journals, { ...opposite, postings: [{ ...opposite.postings[0], amount: money("0.02") }] }] })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, outstanding: money("0.05") })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, outstanding: money("-0.01") })).toThrow(ReconciliationSourceError);
  });
  it("rejects foreign currency, invalid precision and missing action identity without hidden conversions", () => {
    const f = fixture();
    expect(() => employeeReconciliation({ ...f.input, outstanding: money("0.04", "EUR") })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, minorUnit: 0 })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, actionJournalId: randomUUID() })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, reason: " " })).toThrow(ReconciliationSourceError);
    expect(() => employeeReconciliation({ ...f.input, journals: [f.recognition] })).toThrow(ReconciliationSourceError);
  });
  it("preserves every cent and original input across 200 large native earned/payment plans", () => {
    const decimal = (cents: bigint) => { const digits = cents.toString().padStart(3, "0"); return digits.slice(0, -2) + "." + digits.slice(-2); };
    fc.assert(fc.property(fc.bigInt({ min: 9007199254740993n, max: 999999999999999999n }), cents => {
      const f = fixture(decimal(cents), decimal(cents - 1n)), before = JSON.stringify(f.input), plan = employeeReconciliation(f.input).plan;
      expect(plan.expected).toBe(decimal(cents)); expect(plan.actual).toBe(decimal(cents - 1n)); expect(plan.variance).toBe("-0.01"); expect(JSON.stringify(f.input)).toBe(before);
    }), { numRuns: 200 });
  });
});
