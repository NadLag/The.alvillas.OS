import { describe, expect, it } from "vitest";
import { approvalDecisionSchema, approvalRequestSchema } from "@/platform/approvals/approval";
import { notificationRoutingSchema, notificationRoutingSaveSchema } from "@/platform/notifications/notification-routing";
import { notificationDestination } from "@/platform/notifications/notification";
import { defaultNotificationPreferences, shouldDeliverNotification } from "@/platform/notifications/notification-preferences";
import { EmailNotificationChannel } from "@/platform/providers/real";
import type { EmailProvider } from "@/platform/providers";

describe("approval notification contracts", () => {
  it("preserves localized email content, escapes markup and forwards the durable provider key", async () => {
    const sent: Parameters<EmailProvider["send"]>[0][] = [];
    const channel = new EmailNotificationChannel({ send: (input) => { sent.push(input); return Promise.resolve({ id: "test-acknowledgement" }); } });
    await expect(channel.notify({ userId: "reviewer@example.test", subject: "Approbation", body: '<script>alert("unsafe")</script>', locale: "fr", idempotencyKey: "approval-test-key" })).resolves.toEqual({ id: "test-acknowledgement" });
    expect(sent[0]).toMatchObject({ to: "reviewer@example.test", locale: "fr", idempotencyKey: "approval-test-key", text: '<script>alert("unsafe")</script>' });
    expect(sent[0].html).not.toContain("<script>"); expect(sent[0].html).toContain("&lt;script&gt;");
  });
  it("validates approval events and all supported channels without accepting arbitrary destinations", () => {
    const routing = { roles: [], people: [], assigned: false, channels: ["in_app", "email", "push"] };
    for (const kind of ["approval_requested", "approval_decided"]) expect(notificationRoutingSaveSchema.safeParse({ kind, routing, propertyId: null, reason: "Configured approval routing" }).success).toBe(true);
    expect(notificationRoutingSchema.safeParse({ ...routing, channels: ["sms"] }).success).toBe(false);
    expect(approvalRequestSchema.safeParse({ propertyId: crypto.randomUUID(), title: "Inspection", details: "Please review", idempotencyKey: crypto.randomUUID(), recipientId: crypto.randomUUID() }).success).toBe(false);
    expect(approvalDecisionSchema.safeParse({ id: crypto.randomUUID(), decision: "APPROVED", reason: "" }).success).toBe(false);
  });
  it("requires channel consent and respects operational opt-outs for both approval events", () => {
    const preferences = defaultNotificationPreferences();
    for (const kind of ["approval_requested", "approval_decided"]) {
      expect(shouldDeliverNotification(kind, "in_app", preferences)).toBe(true);
      expect(shouldDeliverNotification(kind, "email", preferences)).toBe(false);
      expect(shouldDeliverNotification(kind, "push", preferences)).toBe(false);
      preferences.email = { security: true, enabled: true, account: false, operations: true };
      preferences.push = { enabled: true, account: false, operations: true };
      expect(shouldDeliverNotification(kind, "email", preferences)).toBe(true);
      expect(shouldDeliverNotification(kind, "push", preferences)).toBe(true);
      preferences.in_app.operations = false; expect(shouldDeliverNotification(kind, "in_app", preferences)).toBe(false);
      preferences.in_app.operations = true; preferences.email = { security: true }; preferences.push = undefined;
    }
  });
  it("checks tenant, recipient and current property scope on notification navigation", () => {
    const ctx = { organizationId: "org", userAccountId: "account", permissions: new Set(["property:view"]), scopes: [{ organizationId: "org", scopeType: "property" as const, scopeId: "villa" }] };
    const target = { type: "property", organizationId: "org", id: "approval", propertyId: "villa" };
    const input = { kind: "approval_requested" as const, recipientId: "account", targetId: "approval" };
    expect(notificationDestination(ctx, input, target, "fr")).toBe("/fr/app/approvals/approval");
    expect(notificationDestination(ctx, input, { ...target, organizationId: "other" }, "fr")).toBeNull();
    expect(notificationDestination(ctx, input, { ...target, propertyId: "other" }, "fr")).toBeNull();
    expect(notificationDestination(ctx, { ...input, recipientId: "other" }, target, "fr")).toBeNull();
  });
});
