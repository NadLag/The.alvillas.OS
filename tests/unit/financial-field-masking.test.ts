import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthAssignment } from "@/platform/authz/authorize";
import { present, maskedValue, catalogFieldPolicy, type PresentationContext, type FieldPolicy } from "@/platform/authz/present";

const org = randomUUID(), propertyId = randomUUID(), otherProperty = randomUUID(), reservationId = randomUUID(), journalId = randomUUID(),
  now = new Date("2032-05-02T12:00:00Z"), occurredAt = new Date("2032-05-01T12:00:00Z"), amount = "9007199254740993.07";
const data = { reference: "Actual scoped financial source", revenue: amount, internalAccount: "PRIVATE_LOCATION" },
  resource = { type: "reservation", organizationId: org, id: reservationId, reservationId, propertyId, financialRecordId: journalId, amount, occurredAt, data };
const policy: FieldPolicy<typeof data> = { revenue: { dataClass: "financial", requiredPermission: "financial_transaction:view" },
  internalAccount: { dataClass: "financial", requiredPermission: "financial_transaction:view", mask: "omit" } };
function assignment(permissions: string[], scopeId = propertyId, conditions?: AuthAssignment["conditions"]): AuthAssignment {
  return { permissions: new Set(permissions), scope: { organizationId: org, scopeType: "property", scopeId }, ...(conditions ? { conditions } : {}) };
}
function ctx(financial: AuthAssignment): PresentationContext {
  const assignments = [assignment(["reservation:view", "reservation:export"]), financial];
  return { organizationId: org, permissions: new Set(assignments.flatMap(item => [...item.permissions])), assignments,
    scopes: assignments.map(item => item.scope), visibleDataClasses: new Set() };
}
describe("financial fields use scoped source authority in the central serializer", () => {
  it("does not turn a financial data-class label into a grant for another source", () => {
    const authority = ctx(assignment(["financial_transaction:view"], otherProperty)); authority.visibleDataClasses = new Set(["financial"]);
    expect(present(authority, "view", resource, policy, now)).toEqual({ reference: data.reference, revenue: maskedValue });
  });
  it("masks finance from a different property while keeping authorized operational data", () => {
    const result = present(ctx(assignment(["financial_transaction:view"], otherProperty)), "view", resource, policy, now);
    expect(result).toEqual({ reference: data.reference, revenue: maskedValue });
  });
  it("does not combine an operational source scope with an unrelated financial permission", () => {
    const authority = ctx(assignment(["financial_transaction:view"], otherProperty));
    authority.permissions = new Set([...authority.permissions, "financial_transaction:export"]);
    expect(present(authority, "view", resource, policy, now).revenue).toBe(maskedValue);
  });
  it("applies the actual exact source amount to a financial cap", () => {
    const denied = ctx(assignment(["financial_transaction:view"], propertyId, { maxAmount: "9007199254740993.06" })), allowed = ctx(assignment(["financial_transaction:view"], propertyId, { maxAmount: amount }));
    expect(present(denied, "view", resource, policy, now).revenue).toBe(maskedValue);
    expect(present(allowed, "view", resource, policy, now).revenue).toBe(amount);
    expect(present(allowed, "view", { ...resource, amount: undefined }, policy, now).revenue).toBe(maskedValue);
  });
  it("uses the same effective time for source grant expiry and the containing resource", () => {
    const financial = { ...assignment(["financial_transaction:view"]), validTo: new Date("2032-05-02T11:59:59Z") };
    expect(present(ctx(financial), "view", resource, policy, now).revenue).toBe(maskedValue);
  });
  it("applies source status and occurrence restrictions", () => {
    for (const conditions of [{ statuses: ["APPROVED"] }, { timeWindow: { startsAt: "2032-05-02T00:00:00Z" } }])
      expect(present(ctx(assignment(["financial_transaction:view"], propertyId, conditions)), "view", resource, policy, now).revenue).toBe(maskedValue);
  });
  it("does not replace an unknown historical occurrence with the current time to satisfy a financial window", () => {
    const authority = ctx(assignment(["financial_transaction:view"], propertyId, { timeWindow: { startsAt: "2032-05-02T00:00:00Z", endsAt: "2032-05-03T00:00:00Z" } }));
    for (const occurredAt of [undefined, null, "invalid-source-date"]) expect(present(authority, "view", { ...resource, occurredAt }, policy, now).revenue).toBe(maskedValue);
  });
  it("keeps owner profitability and company margins behind their independent source permissions", () => {
    const financial = assignment(["financial_transaction:view"]), authority = ctx(financial), financialData = { amount, ownerProfitability: "10.07", alvillasProfit: "0.03" };
    authority.visibleDataClasses = new Set(["financial"]);
    expect(present(authority, "view", { ...resource, type: "financial_transaction", data: financialData }, catalogFieldPolicy("financial_transaction"), now))
      .toEqual({ amount, ownerProfitability: maskedValue, alvillasProfit: maskedValue });
    const granted = ctx(assignment(["financial_transaction:view", "owner_statement:view", "company_ledger:view"]));
    expect(present(granted, "view", { ...resource, type: "financial_transaction", data: financialData }, catalogFieldPolicy("financial_transaction"), now)).toEqual(financialData);
  });
  it("requires original financial export independently of operational export and financial viewing", () => {
    const viewer = ctx(assignment(["financial_transaction:view"])), exporter = ctx(assignment(["financial_transaction:view", "financial_transaction:export"]));
    expect(present(viewer, "view", resource, policy, now).revenue).toBe(amount);
    expect(present(viewer, "export", resource, policy, now)).toEqual({ reference: data.reference, revenue: maskedValue });
    expect(present(exporter, "export", resource, policy, now).revenue).toBe(amount);
  });
  it("does not transfer a source grant between tenants", () => {
    const financial = assignment(["financial_transaction:view"]); financial.scope.organizationId = randomUUID();
    expect(present(ctx(financial), "view", resource, policy, now).revenue).toBe(maskedValue);
  });
  it("retains legitimate scoped financial access and refuses a denied containing resource", () => {
    const authority = ctx(assignment(["financial_transaction:view"]));
    expect(present(authority, "view", resource, policy, now)).toEqual(data);
    expect(() => present(authority, "view", { ...resource, propertyId: otherProperty }, policy, now)).toThrow("Not authorized to present resource");
  });
  it("fails closed on malformed or unknown required permission actions", () => {
    const authority = ctx(assignment(["financial_transaction:arbitrary"]));
    const unknown: FieldPolicy<typeof data> = { revenue: { dataClass: "financial", requiredPermission: "financial_transaction:arbitrary" } };
    expect(present(authority, "view", resource, unknown, now).revenue).toBe(maskedValue);
  });
});
