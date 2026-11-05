import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import type { AuditHistoryRow, FinancialAuditResource } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";

const organizationId = randomUUID(), id = randomUUID(), actorId = randomUUID(), collectionId = randomUUID(), accountId = randomUUID(), propertyId = randomUUID();
const provenance = { amount: { amount: "0.04", currency: "MAD" }, originalCollectionId: collectionId, relatedOwners: [{ ownerId: randomUUID(), shareBps: 10000 }] }, receiptId = randomUUID();
const entry: AuditHistoryRow = { id: randomUUID(), actorId, resourceId: id, resourceType: "financial_transaction", action: "finance.guest_payment.provenance_retained", propertyScopeId: propertyId,
  before: null, after: { receiptId, provenance }, reason: "Original private collected guest funds", requestId: randomUUID(), occurredAt: new Date(0), createdAt: new Date(0), ipAddress: null, deviceId: null };
const source: FinancialAuditResource = { type: "financial_transaction", organizationId, id, financialRecordId: id, propertyId, amount: "0.04", dataClass: "financial",
  guestPayment: { receiptId, actorId, reason: entry.reason, provenance, originalCollectionId: collectionId, receivedAt: new Date(0),
    fundingSources: [{ type: "financial_transaction", organizationId, id: accountId, financialRecordId: accountId, amount: "0.04", dataClass: "financial" }],
    cashSource: { type: "cash_collection", organizationId, id: collectionId, propertyId, amount: "0.07", dataClass: "financial" } } };
const view = ["financial_transaction:view", "cash_collection:view"];
function context(keys = view): AuditActorContext { return { organizationId, actorId, personId: actorId,
  authContext: { organizationId, userAccountId: actorId, permissions: new Set(["audit_log:view", "audit_log:export", ...keys]), scopes: [{ organizationId, scopeType: "organization" }] } }; }
function hidden(row: AuditHistoryRow) { expect(row.after).toBe(maskedValue); expect(row.before).toBe(maskedValue); expect(row.reason).toBe(maskedValue); }
describe("native guest payment provenance audit disclosure", () => {
  it("requires the actual original receipt, funding account and cash source", () => {
    expect(presentAuditHistoryRow(context(), entry, "view", source).after).toEqual(entry.after);
    hidden(presentAuditHistoryRow(context(), entry));
    hidden(presentAuditHistoryRow(context([]), entry, "view", source));
    hidden(presentAuditHistoryRow(context(["financial_transaction:view"]), entry, "view", source));
  });
  it("requires independent exports for both the financial and original cash sources", () => {
    const exports = ["financial_transaction:export", "cash_collection:export"];
    for (const missing of exports) hidden(presentAuditHistoryRow(context([...view, ...exports.filter(key => key !== missing)]), entry, "export", source));
    expect(presentAuditHistoryRow(context([...view, ...exports]), entry, "export", source).after).toEqual(entry.after);
  });
  it("does not use a small admission to disclose a larger original cash collection outside its grant", () => {
    const ctx = context(); ctx.authContext.assignments = [{ scope: { organizationId, scopeType: "organization" }, permissions: new Set(["audit_log:view", "financial_transaction:view"]) },
      { scope: { organizationId, scopeType: "organization" }, permissions: new Set(["cash_collection:view"]), conditions: { maxAmount: "0.05" } }];
    hidden(presentAuditHistoryRow(ctx, entry, "view", source));
  });
  it("rejects substituted audit payload, reason, actor, before data and resource labels", () => {
    for (const changed of [{ ...entry, after: { receiptId: randomUUID(), provenance } }, { ...entry, reason: "A forged hidden historical amount" }, { ...entry, actorId: randomUUID() },
      { ...entry, before: { privateData: "must not disclose" } }, { ...entry, resourceType: "task" }]) hidden(presentAuditHistoryRow(context(), changed, "view", source));
  });
  it("withholds an unavailable or foreign original cash source", () => {
    for (const cashSource of [undefined, { ...source.guestPayment!.cashSource!, organizationId: randomUUID() }, { ...source.guestPayment!.cashSource!, id: randomUUID() }])
      hidden(presentAuditHistoryRow(context(), entry, "view", { ...source, guestPayment: { ...source.guestPayment!, cashSource } }));
  });
  it("requires the independent funding wallet when the native account belongs to a person", () => {
    const wallet = { type: "wallet", organizationId, id: randomUUID(), amount: "0.04", dataClass: "financial" as const }, actual = { ...source, guestPayment: { ...source.guestPayment!, fundingSources: [...source.guestPayment!.fundingSources, wallet] } };
    hidden(presentAuditHistoryRow(context(), entry, "view", actual));
    expect(presentAuditHistoryRow(context([...view, "wallet:view"]), entry, "view", actual).after).toEqual(entry.after);
  });
});
