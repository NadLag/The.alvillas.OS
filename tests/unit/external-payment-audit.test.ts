import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import type { AuditHistoryRow, FinancialAuditResource } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";

const organizationId = randomUUID(), actorId = randomUUID(), id = randomUUID(), accountId = randomUUID(), propertyId = randomUUID();
const original = { type: "financial_transaction", organizationId, id, financialRecordId: id, propertyId, amount: "9007199254740993.07", occurredAt: "2026-11-05T00:00:00Z", dataClass: "financial" as const };
const capture = { ...original, occurredAt: "2026-10-31T23:59:59Z" }, funding = [original, capture].map(row => ({ ...row, id: accountId, financialRecordId: accountId }));
const source: FinancialAuditResource = { ...original, externalPayment: { original, capture, funding } };
const entry: AuditHistoryRow = { id: randomUUID(), actorId: null, resourceId: id, resourceType: "financial_transaction", action: "finance.external_payment.captured", propertyScopeId: null,
  before: null, after: { intentId: id, evidence: { amount: { amount: original.amount, currency: "MAD" } } }, reason: "Actual private original capture", requestId: randomUUID(), occurredAt: new Date(), createdAt: new Date(), ipAddress: null, deviceId: null };
function context(keys = ["financial_transaction:view"]): AuditActorContext { return { organizationId, actorId, personId: actorId,
  authContext: { organizationId, userAccountId: actorId, permissions: new Set(["audit_log:view", "audit_log:export", ...keys]), scopes: [{ organizationId, scopeType: "organization" }] } }; }
function hidden(row: AuditHistoryRow) { expect(row.after).toBe(maskedValue); expect(row.before).toBe(maskedValue); expect(row.reason).toBe(maskedValue); }
describe("original external payment audit authority", () => {
  it("requires actual source binding for every optional payment event", () => {
    for (const action of ["requested", "capture_started", "captured", "capture_time_retained", "settlement_retained", "capture_unconfirmed", "viewed", "admission_reviewed", "reconciliation_requested"]) {
      const row = { ...entry, action: "finance.external_payment." + action };
      expect(presentAuditHistoryRow(context(), row, "view", source).after).toEqual(row.after);
      hidden(presentAuditHistoryRow(context(), row)); hidden(presentAuditHistoryRow(context([]), row, "view", source));
    }
  });
  it("requires independent funding authority even when the original intent is visible", () => {
    const ctx = context(); ctx.authContext.assignments = [{ scope: { organizationId, scopeType: "organization" }, permissions: new Set(["audit_log:view"]) },
      { scope: { organizationId, scopeType: "financial_record", scopeId: id }, permissions: new Set(["financial_transaction:view"]) }];
    hidden(presentAuditHistoryRow(ctx, entry, "view", source));
    ctx.authContext.assignments = [...ctx.authContext.assignments, { scope: { organizationId, scopeType: "financial_record", scopeId: accountId }, permissions: new Set(["financial_transaction:view"]) }];
    expect(presentAuditHistoryRow(ctx, entry, "view", source).after).toEqual(entry.after);
  });
  it("requires view and export authority on each original source and funding account", () => {
    hidden(presentAuditHistoryRow(context(), entry, "export", source));
    hidden(presentAuditHistoryRow(context(["financial_transaction:export"]), entry, "export", source));
    expect(presentAuditHistoryRow(context(["financial_transaction:view", "financial_transaction:export"]), entry, "export", source).after).toEqual(entry.after);
  });
  it("requires the actual independent expense permission for fee history without concealing ordinary capture facts", () => {
    const fee = { ...capture, id: randomUUID(), type: "expense", amount: "0.02" }, actual = { ...source, externalPayment: { ...source.externalPayment!, fee } }, row = { ...entry, action: "finance.external_payment.fee_prepared" };
    hidden(presentAuditHistoryRow(context(), row, "view", actual)); hidden(presentAuditHistoryRow(context(["financial_transaction:view", "expense:view"]), row, "view", source));
    expect(presentAuditHistoryRow(context(["financial_transaction:view", "expense:view"]), row, "view", actual).after).toEqual(row.after);
    hidden(presentAuditHistoryRow(context(["financial_transaction:view", "financial_transaction:export", "expense:view"]), row, "export", actual));
    expect(presentAuditHistoryRow(context(["financial_transaction:view", "financial_transaction:export", "expense:view", "expense:export"]), row, "export", actual).after).toEqual(row.after);
    expect(presentAuditHistoryRow(context(), entry, "view", actual).after).toEqual(entry.after);
  });
  it("does not disclose prior-month capture facts through a reconciliation-month date grant", () => {
    const ctx = context(); ctx.authContext.assignments = [{ scope: { organizationId, scopeType: "organization" }, permissions: new Set(["audit_log:view"]) },
      { scope: { organizationId, scopeType: "organization" }, permissions: new Set(["financial_transaction:view"]), conditions: { timeWindow: { startsAt: "2026-11-01T00:00:00Z" } } }];
    hidden(presentAuditHistoryRow(ctx, entry, "view", source));
  });
  it("compares the full exact original Money against conditional grants", () => {
    const ctx = context(); ctx.authContext.assignments = [{ scope: { organizationId, scopeType: "organization" }, permissions: new Set(["audit_log:view"]) },
      { scope: { organizationId, scopeType: "organization" }, permissions: new Set(["financial_transaction:view"]), conditions: { maxAmount: "9007199254740993.06" } }];
    hidden(presentAuditHistoryRow(ctx, entry, "view", { ...source, amount: "0.01" }));
  });
  it("withholds legacy unbound, foreign, substituted and incomplete sources", () => {
    for (const externalPayment of [undefined, { ...source.externalPayment!, funding: [] }, { ...source.externalPayment!, original: { ...original, organizationId: randomUUID() } },
      { ...source.externalPayment!, capture: { ...capture, id: randomUUID() } }, { ...source.externalPayment!, funding: [{ ...funding[0], organizationId: randomUUID() }] }])
      hidden(presentAuditHistoryRow(context(), entry, "view", { ...source, externalPayment }));
    hidden(presentAuditHistoryRow(context(), { ...entry, resourceType: "task" }, "view", source));
    hidden(presentAuditHistoryRow(context(), { ...entry, resourceId: randomUUID() }, "view", source));
  });
});
