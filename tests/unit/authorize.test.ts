import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizeCollection,
  permissionKey,
  type AuthContext
} from "@/platform/authz/authorize";

const ctx: AuthContext = {
  organizationId: "org-a",
  permissions: new Set([permissionKey("reservation", "view")]),
  scopes: [{ organizationId: "org-a", resourceType: "reservation", resourceId: "res-1" }]
};

describe("authorize", () => {
  it("denies by default without permission", () => {
    expect(
      authorize(ctx, "edit", { type: "reservation", organizationId: "org-a", id: "res-1" })
    ).toBe(false);
  });

  it("denies wrong tenant", () => {
    expect(
      authorize(ctx, "view", { type: "reservation", organizationId: "org-b", id: "res-1" })
    ).toBe(false);
  });

  it("denies wrong scope", () => {
    expect(
      authorize(ctx, "view", { type: "reservation", organizationId: "org-a", id: "res-2" })
    ).toBe(false);
  });

  it("allows matching permission and scope", () => {
    expect(
      authorize(ctx, "view", { type: "reservation", organizationId: "org-a", id: "res-1" })
    ).toBe(true);
  });

  it("allows property-scoped access to child reservations and tasks", () => {
    const propertyScoped: AuthContext = {
      organizationId: "org-a",
      permissions: new Set([permissionKey("reservation", "view"), permissionKey("task", "view")]),
      scopes: [{ organizationId: "org-a", scopeType: "property", scopeId: "property-1" }]
    };

    expect(
      authorize(propertyScoped, "view", {
        type: "reservation",
        organizationId: "org-a",
        id: "res-1",
        propertyId: "property-1"
      })
    ).toBe(true);
    expect(
      authorize(propertyScoped, "view", {
        type: "task",
        organizationId: "org-a",
        id: "task-1",
        propertyId: "property-2"
      })
    ).toBe(false);
  });

  it("allows region and city scoped access to child properties", () => {
    const regionScoped: AuthContext = {
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a", scopeType: "region", scopeId: "region-1" }]
    };
    const cityScoped: AuthContext = {
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a", scopeType: "city", scopeId: "city-1" }]
    };

    expect(
      authorize(regionScoped, "view", {
        type: "property",
        organizationId: "org-a",
        id: "property-1",
        region: "region-1",
        city: "city-1"
      })
    ).toBe(true);
    expect(
      authorize(cityScoped, "view", {
        type: "property",
        organizationId: "org-a",
        id: "property-1",
        region: "region-1",
        city: "city-1"
      })
    ).toBe(true);
    expect(
      authorize(cityScoped, "view", {
        type: "property",
        organizationId: "org-a",
        id: "property-2",
        region: "region-1",
        city: "city-2"
      })
    ).toBe(false);
  });

  it("enforces assigned-to-me, status and amount ABAC conditions", () => {
    const conditional: AuthContext = {
      organizationId: "org-a",
      userAccountId: "account-1",
      permissions: new Set([permissionKey("task", "edit"), permissionKey("financial_transaction", "approve")]),
      scopes: [{ organizationId: "org-a" }],
      assignments: [
        {
          roleKey: "housekeeper",
          permissions: new Set([permissionKey("task", "edit")]),
          scope: { organizationId: "org-a", scopeType: "job", scopeId: "task-1" },
          conditions: { assignedToMe: true, statuses: ["OPEN"] }
        },
        {
          roleKey: "finance",
          permissions: new Set([permissionKey("financial_transaction", "approve")]),
          scope: { organizationId: "org-a" },
          conditions: { maxAmount: "1000.00" }
        }
      ]
    };

    expect(
      authorize(conditional, "edit", {
        type: "task",
        organizationId: "org-a",
        id: "task-1",
        assignedUserAccountId: "account-1",
        status: "OPEN"
      })
    ).toBe(true);
    expect(
      authorize(conditional, "edit", {
        type: "task",
        organizationId: "org-a",
        id: "task-1",
        assignedUserAccountId: "account-2",
        status: "OPEN"
      })
    ).toBe(false);
    expect(
      authorize(conditional, "approve", {
        type: "financial_transaction",
        organizationId: "org-a",
        id: "tx-1",
        amount: "999.99"
      })
    ).toBe(true);
    expect(
      authorize(conditional, "approve", {
        type: "financial_transaction",
        organizationId: "org-a",
        id: "tx-2",
        amount: "1000.01"
      })
    ).toBe(false);
  });

  it("allows collection entry only when a role assignment carries the permission", () => {
    expect(authorizeCollection(ctx, "view", "reservation")).toBe(true);
    expect(authorizeCollection(ctx, "create", "reservation")).toBe(false);
  });

  it("denies expired assignments", () => {
    const expired: AuthContext = {
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a", scopeType: "property", scopeId: "property-1" }],
      assignments: [
        {
          roleKey: "co_host",
          permissions: new Set([permissionKey("property", "view")]),
          scope: { organizationId: "org-a", scopeType: "property", scopeId: "property-1" },
          validFrom: new Date("2026-01-01T00:00:00.000Z"),
          validTo: new Date("2026-01-02T00:00:00.000Z")
        }
      ]
    };

    expect(
      authorize(expired, "view", {
        type: "property",
        organizationId: "org-a",
        id: "property-1",
        propertyId: "property-1"
      })
    ).toBe(false);
  });
});
