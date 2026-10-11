import { describe, expect, it } from "vitest";
import { authorize, permissionKey, type AuthContext } from "@/platform/authz/authorize";

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
});
