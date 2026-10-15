import { describe, expect, it } from "vitest";
import { notificationRoutingSaveSchema, notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { notificationDestination } from "@/platform/notifications/notification";
import { shouldDeliverNotification, defaultNotificationPreferences } from "@/platform/notifications/notification-preferences";

describe("event routing contracts", () => {
  it("rejects arbitrary channels, unknown events, unvalidated recipients and injected targets", () => {
    const routing = { roles: [], people: [], assigned: true, channels: ["in_app"] };
    expect(notificationRoutingSchema.safeParse(routing).success).toBe(true);
    for (const value of [{ ...routing, roles: ["admin"] }, { ...routing, people: ["someone"] }, { ...routing, channels: ["push"] }, { ...routing, href: "https://example.test" }]) expect(notificationRoutingSchema.safeParse(value).success).toBe(false);
    expect(notificationRoutingSaveSchema.safeParse({ kind: "approval_requested", propertyId: null, routing, reason: "A real change" }).success).toBe(false);
  });
  it("uses operational preferences for reservation and completion events", () => {
    const preferences = defaultNotificationPreferences();
    for (const kind of ["reservation_created", "task_completed"]) {
      expect(shouldDeliverNotification(kind, "in_app", preferences)).toBe(true);
      preferences.in_app.operations = false;
      expect(shouldDeliverNotification(kind, "in_app", preferences)).toBe(false);
      preferences.in_app.operations = true;
    }
  });
  it("rechecks reservation and supervisor task access before returning destinations", () => {
    const ctx = { organizationId: "org", userAccountId: "account", permissions: new Set(["task:view", "reservation:view"]), scopes: [{ organizationId: "org", scopeType: "property" as const, scopeId: "villa" }] };
    const target = { type: "reservation", organizationId: "org", id: "record", propertyId: "villa" };
    const input = { kind: "reservation_created" as const, recipientId: "account", targetId: "record" };
    expect(notificationDestination(ctx, input, target, "fr")).toBe("/fr/app/reservations");
    expect(notificationDestination(ctx, input, { ...target, propertyId: "other" }, "fr")).toBeNull();
    expect(notificationDestination(ctx, { ...input, kind: "task_completed" }, { ...target, type: "task" }, "ar")).toBe("/ar/app/operations");
  });
});
