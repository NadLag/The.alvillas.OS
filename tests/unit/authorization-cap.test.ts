import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";

function fixture(): AuthContext {
  const organizationId = randomUUID(), userAccountId = randomUUID();
  return { organizationId, userAccountId, personId: randomUUID(), permissions: new Set(["financial_transaction:view", "financial_transaction:create"]),
    scopes: [{ organizationId, scopeType: "organization" }], assignments: [{ roleKey: "original_finance_scope", permissions: new Set(["financial_transaction:view", "financial_transaction:create"]),
      scope: { organizationId, scopeType: "property", scopeId: randomUUID() }, conditions: { maxAmount: "1200.01", assignedToMe: true, statuses: ["APPROVED"],
        timeWindow: { startsAt: "2026-01-01T00:00:00.000Z", endsAt: new Date("2026-12-31T00:00:00.000Z") } },
      validFrom: new Date("2026-01-01T00:00:00.000Z"), validTo: new Date("2026-11-01T00:00:00.000Z") }] };
}
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
describe("durable caller authorization restrictions", () => {
  it("round-trips sets, actual identities, scoped roles and date restrictions through JSON", () => {
    const original = fixture(), restored = restoreAuthorizationCap(wire(captureAuthorizationCap(original)));
    expect(restored).toEqual({ ...original, assignments: original.assignments?.map(item => ({ ...item,
      conditions: { ...item.conditions, timeWindow: { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-12-31T00:00:00.000Z" } } })) });
  });
  it("preserves every allow/deny decision across scope, amount, status, assignment and expiry", () => {
    const original = fixture(), restored = restoreAuthorizationCap(wire(captureAuthorizationCap(original)));
    for (const propertyId of [original.assignments![0].scope.scopeId, randomUUID()]) for (const amount of ["0.01", "1200.01", "1200.02"])
      for (const status of ["APPROVED", "REJECTED"]) for (const assignedUserAccountId of [original.userAccountId, randomUUID()])
        for (const now of [new Date("2025-12-31"), new Date("2026-10-29"), new Date("2026-11-02")]) {
          const resource: Resource = { type: "financial_transaction", organizationId: original.organizationId, propertyId, amount, status,
            assignedUserAccountId, occurredAt: new Date("2026-10-01"), dataClass: "financial" };
          expect(authorize(restored, "create", resource, now)).toBe(authorize(original, "create", resource, now));
        }
  });
  it("keeps empty assignments distinct from a legacy permission/scope context", () => {
    const original = fixture(), legacy = { ...original, assignments: undefined }, empty = { ...original, assignments: [] };
    for (const value of [legacy,empty]) {
      const restored = restoreAuthorizationCap(wire(captureAuthorizationCap(value)));
      expect(restored.assignments).toEqual(value.assignments);
      const resource = { type: "financial_transaction", organizationId: value.organizationId, dataClass: "financial" as const };
      expect(authorize(restored,"view",resource,new Date("2026-10-29"))).toBe(authorize(value,"view",resource,new Date("2026-10-29")));
    }
  });
  it("fails closed for an unknown condition instead of discarding the restriction", () => {
    const cap = captureAuthorizationCap(fixture());
    expect(() => restoreAuthorizationCap({ ...cap, assignments: cap.assignments?.map(item => ({ ...item, conditions: { ...item.conditions, futureRestriction: true } })) })).toThrow();
  });
  it("rejects foreign scopes and incomplete or unversioned request restrictions", () => {
    const cap = captureAuthorizationCap(fixture());
    for (const value of [{ ...cap, schemaVersion: 2 }, { ...cap, userAccountId: undefined }, { ...cap, permissions: undefined },
      { ...cap, scopes: [{ organizationId: randomUUID(), scopeType: "organization" }] }]) expect(() => restoreAuthorizationCap(value)).toThrow();
  });
  it("retains a narrowed caller permission set despite wider assignment permissions", () => {
    const original = fixture(); original.permissions = new Set(["financial_transaction:view"]);
    const restored = restoreAuthorizationCap(wire(captureAuthorizationCap(original))), resource: Resource = { type: "financial_transaction", organizationId: original.organizationId,
      propertyId: original.assignments![0].scope.scopeId, amount: "1.00", status: "APPROVED", assignedUserAccountId: original.userAccountId, occurredAt: new Date("2026-10-01"), dataClass: "financial" };
    expect(authorize(restored,"create",resource,new Date("2026-10-29"))).toBe(false);
    expect(authorize(restored,"view",resource,new Date("2026-10-29"))).toBe(true);
  });
});
