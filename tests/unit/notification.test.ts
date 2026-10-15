import { describe, expect, it } from "vitest";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { notificationDestination, notificationInputSchema, notificationPageSchema, ownNotificationContext } from "@/platform/notifications/notification";

const org = "018f0a0b-0000-7000-9000-000000000001";
const account = "018f0a0b-0000-7000-9000-000000000002";
const task = "018f0a0b-0000-7000-9000-000000000003";
const context = (): AuthContext => ownNotificationContext({ organizationId: org, permissions: new Set(), scopes: [{ organizationId: org }] }, account);
const resource: Resource = { type: "task", organizationId: org, id: task, propertyId: "property-a", assignedUserAccountId: account };
const input = { kind: "task_assigned" as const, recipientId: account, targetId: task };

describe("personal notification permissions and safe destinations", () => {
  it("grants only the account inbox and never other inboxes, collections or tenants", () => {
    const ctx = context();
    expect(authorize(ctx, "view", { type: "notification", organizationId: org, id: account })).toBe(true);
    expect(authorize(ctx, "edit", { type: "notification", organizationId: org, id: account })).toBe(true);
    for (const denied of [{ type: "notification", organizationId: org }, { type: "notification", organizationId: org, id: task }, { type: "notification", organizationId: task, id: account }]) {
      expect(authorize(ctx, "view", denied)).toBe(false);
    }
    expect(authorize(ctx, "view", resource)).toBe(false);
  });
  it("checks current task permissions, scope, assignment and tenant before generating any URL", () => {
    const scope = { organizationId: org, scopeType: "property" as const, scopeId: "property-a" };
    const ctx = ownNotificationContext({ organizationId: org, permissions: new Set(["task:view"]), scopes: [scope],
      assignments: [{ scope, permissions: new Set(["task:view"]), conditions: { assignedToMe: true } }] }, account);
    expect(notificationDestination(ctx, input, resource, "fr")).toBe(`/fr/app/field/${task}`);
    for (const target of [null, { ...resource, organizationId: task }, { ...resource, propertyId: "property-b" }, { ...resource, assignedUserAccountId: task }, { ...resource, id: account }]) {
      expect(notificationDestination(ctx, input, target, "en")).toBeNull();
    }
    expect(notificationDestination(context(), input, resource, "en")).toBeNull();
    expect(notificationDestination(ctx, { ...input, recipientId: task }, resource, "en")).toBeNull();
  });
  it("allows own language record only without granting identity administration", () => {
    const ctx = context();
    expect(notificationDestination(ctx, { kind: "language_updated", recipientId: account, targetId: account }, { type: "identity", organizationId: org, id: account }, "ar")).toBe("/ar/app");
    expect(notificationDestination(ctx, { kind: "language_updated", recipientId: account, targetId: task }, { type: "identity", organizationId: org, id: task }, "en")).toBeNull();
    expect(authorize(ctx, "configure", { type: "identity", organizationId: org })).toBe(false);
  });
  it("rejects arbitrary URLs, message payloads and unbounded pagination input", () => {
    expect(notificationInputSchema.safeParse({ ...input, href: "https://example.test" }).success).toBe(false);
    expect(notificationInputSchema.safeParse({ ...input, kind: "financial_update" }).success).toBe(false);
    expect(notificationPageSchema.safeParse({ limit: 100000 }).success).toBe(false);
    expect(notificationPageSchema.safeParse({ cursor: { id: "invalid", createdAt: "yesterday" } }).success).toBe(false);
  });
});
