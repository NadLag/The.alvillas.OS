import { describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { authorize } from "@/platform/authz/authorize";

const org = "018f0a0b-0000-7000-9000-000000000001";
vi.mock("@/platform/authz/account-context", () => ({
  authContextForAccount: () => Promise.resolve({ organizationId: org, permissions: new Set(), scopes: [{ organizationId: org }], assignments: [] })
}));

describe("own account security", () => {
  it("requires an authenticated session", async () => {
    await expect(identityActorContextFromSession(null)).resolves.toBeNull();
  });
  it("permits only the signed-in person's own factors", async () => {
    const session = { user: { id: "account-a", personId: "person-a", organizationId: org } } as Session;
    const actor = await identityActorContextFromSession(session);
    if (!actor) throw new Error("Expected actor");
    const resource = { type: "identity", organizationId: org, id: "account-a" };
    expect(authorize(actor.authContext, "configure", resource)).toBe(true);
    expect(authorize(actor.authContext, "configure", { ...resource, id: "account-b" })).toBe(false);
    expect(authorize(actor.authContext, "configure", { ...resource, organizationId: "another-tenant" })).toBe(false);
    expect(authorize(actor.authContext, "configure", { type: "identity", organizationId: org })).toBe(false);
    expect(authorize(actor.authContext, "view", { type: "identity", organizationId: org })).toBe(false);
    expect(authorize(actor.authContext, "assign", { ...resource, type: "role" })).toBe(false);
  });
});
