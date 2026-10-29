import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { supplierInvoiceRecognitionCosts, type SupplierInvoiceRecognitionSource } from "@/modules/finance/domain/supplier-invoice-recognition";
import { supplierInvoicePostings } from "@/modules/finance/domain/supplier-payable";
import { Money } from "@/platform/money/money";

const money = (amount: string) => ({ amount, currency: "MAD" });
function fixture() {
  const source: SupplierInvoiceRecognitionSource = { organizationId: randomUUID(), invoiceId: randomUUID(), revisionId: randomUUID(), supplierId: randomUUID(),
    sourceInvoiceVersion: 0, occurredOn: "2026-10-28", amount: "2400.01", currency: "MAD", lines: [
      { id: randomUUID(), position: 1, propertyId: randomUUID(), reservationId: null, amount: "2400.01", currency: "MAD", category: "maintenance", costCenter: null } ] };
  const original = source.lines[0], owners = [randomUUID(), randomUUID()];
  const allocation = { owner: money("2400.01"), alvillas: money("0.00"), guest: money("0.00") };
  const policies = owners.map((ownerId, index) => ({ ownerId, ownerName: "Original owner", shareBps: 5000, sourceAmount: money(index ? "1200.00" : "1200.01"),
    allocation: { owner: money(index ? "1200.00" : "1200.01"), alvillas: money("0.00"), guest: money("0.00") } }));
  const snapshot = { schemaVersion: 1, invoiceId: source.invoiceId, revisionId: source.revisionId, supplierId: source.supplierId, sourceInvoiceVersion: 0,
    occurredOn: source.occurredOn, amount: money(source.amount), lines: [{ ...original, amount: money(original.amount), policy: { schemaVersion: 1,
      sourceKind: "supplier_invoice_line", invoiceId: source.invoiceId, revisionId: source.revisionId, lineId: original.id, propertyId: original.propertyId,
      reservationId: null, occurredOn: source.occurredOn, timezone: "Europe/Paris", amount: money(original.amount), category: original.category, allocation, policies } }] };
  return { source, snapshot, owners };
}
describe("immutable supplier invoice recognition costs", () => {
  it("retains original per-owner cents and line calendar through the existing payable recipe", () => {
    const { source, snapshot, owners } = fixture(), costs = supplierInvoiceRecognitionCosts(source, snapshot);
    expect(costs[0].ownerAmounts.map(row => row.amount.toJSON().amount)).toEqual(["1200.01", "1200.00"]);
    expect(costs[0].sourceOccurredAt.toISOString()).toBe("2026-10-27T23:00:00.000Z");
    const postings = supplierInvoicePostings({ invoiceId: source.invoiceId, supplierId: source.supplierId, amount: Money.of(source.amount, source.currency), liabilityAccountId: "claim",
      lines: costs.map(cost => ({ ...cost, ownerAccounts: new Map(owners.map(id => [id, "owner-claim"])), companyExpenseAccountId: "company", guestReceivableAccountId: "guest" })) });
    expect(postings.map(row => [row.side, row.amount.toJSON().amount, row.bucket])).toEqual([
      ["DEBIT", "1200.01", "OWNER_EXPENSE"], ["DEBIT", "1200.00", "OWNER_EXPENSE"], ["CREDIT", "2400.01", "SUPPLIER_INVOICE"] ]);
  });
  it.each(["invoiceId", "revisionId", "supplierId"] as const)("rejects a snapshot bound to another %s", key => {
    const f = fixture(); f.snapshot[key] = randomUUID(); expect(() => supplierInvoiceRecognitionCosts(f.source, f.snapshot)).toThrow();
  });
  it("rejects another version/date, missing lines and duplicate actual source identities", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.snapshot.sourceInvoiceVersion++; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.occurredOn = "2026-10-27"; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines = []; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines.push(f.snapshot.lines[0]); f.source.lines = [...f.source.lines, f.source.lines[0]]; }
    ]) { const f = fixture(); change(f); expect(() => supplierInvoiceRecognitionCosts(f.source, f.snapshot)).toThrow(); }
  });
  it("rejects changed line source, category, cost center, amount and currency", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].propertyId = randomUUID(); },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].category = "office"; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].policy.amount.amount = "2400.00"; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].policy.amount.currency = "USD"; },
      (f: ReturnType<typeof fixture>) => { f.source.lines = [{ ...f.source.lines[0], costCenter: "office" }]; }
    ]) { const f = fixture(); change(f); expect(() => supplierInvoiceRecognitionCosts(f.source, f.snapshot)).toThrow(); }
  });
  it("rejects duplicate owners, altered owner shares, unbalanced slices and redistributed frozen allocations", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].policy.policies[1].ownerId = f.owners[0]; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].policy.policies[0].shareBps = 4999; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].policy.policies[0].sourceAmount.amount = "1200.00"; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.lines[0].policy.policies[0].allocation.owner.amount = "1200.00"; f.snapshot.lines[0].policy.policies[0].allocation.alvillas.amount = "0.01"; }
    ]) { const f = fixture(); change(f); expect(() => supplierInvoiceRecognitionCosts(f.source, f.snapshot)).toThrow(); }
  });
  it("accepts company-only costs with their actual organization and no invented owner or property", () => {
    const f = fixture(), original = f.source.lines[0];
    f.source.lines = [{ ...original, propertyId: null, costCenter: "office" }];
    const line = f.snapshot.lines[0];
    const snapshot = { ...f.snapshot, lines: [{ ...line, propertyId: null, costCenter: "office", policy: { ...line.policy, propertyId: null,
      allocation: { owner: money("0"), alvillas: money(f.source.amount), guest: money("0") }, policies: [{ organizationId: f.source.organizationId }] } }] };
    const costs = supplierInvoiceRecognitionCosts(f.source, snapshot);
    expect(costs[0].owners).toEqual([]); expect(costs[0].ownerAmounts).toEqual([]); expect(costs[0].costCenter).toBe("office");
    snapshot.lines[0].policy.policies[0].organizationId = randomUUID(); expect(() => supplierInvoiceRecognitionCosts(f.source, snapshot)).toThrow();
  });
  it("requires a real reservation for guest cost and preserves valid zero-cent owner slices", () => {
    const f = fixture(), policy = f.snapshot.lines[0].policy;
    policy.policies[1].allocation.owner.amount = "0.00"; policy.policies[1].allocation.alvillas.amount = "1200.00";
    policy.allocation.owner.amount = "1200.01"; policy.allocation.alvillas.amount = "1200.00";
    expect(supplierInvoiceRecognitionCosts(f.source, f.snapshot)[0].ownerAmounts[1].amount.toJSON().amount).toBe("0.00");
    policy.policies[1].allocation.alvillas.amount = "0.00"; policy.policies[1].allocation.guest.amount = "1200.00";
    policy.allocation.alvillas.amount = "0.00"; policy.allocation.guest.amount = "1200.00";
    expect(() => supplierInvoiceRecognitionCosts(f.source, f.snapshot)).toThrow();
  });
});
