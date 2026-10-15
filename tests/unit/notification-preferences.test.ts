import { describe, expect, it } from "vitest";
import { defaultNotificationPreferences, notificationPreferencesSchema, shouldDeliverNotification } from "@/platform/notifications/notification-preferences";

describe("notification channel and category policy", () => {
  it("defaults to optional updates and allows independent category and channel opt-outs", () => {
    const preferences = defaultNotificationPreferences();
    expect(shouldDeliverNotification("language_updated", "in_app", null)).toBe(true);
    expect(shouldDeliverNotification("task_assigned", "in_app", null)).toBe(true);
    preferences.in_app.account = false;
    expect(shouldDeliverNotification("language_updated", "in_app", preferences)).toBe(false);
    expect(shouldDeliverNotification("task_assigned", "in_app", preferences)).toBe(true);
    preferences.in_app.account = true; preferences.in_app.operations = false;
    expect(shouldDeliverNotification("language_updated", "in_app", preferences)).toBe(true);
    expect(shouldDeliverNotification("task_assigned", "in_app", preferences)).toBe(false);
    preferences.in_app.enabled = false;
    expect(shouldDeliverNotification("language_updated", "in_app", preferences)).toBe(false);
    expect(defaultNotificationPreferences().in_app.account).toBe(true);
  });
  it("always delivers mandatory security events through their implemented channel", () => {
    const preferences = defaultNotificationPreferences();
    preferences.in_app = { enabled: false, account: false, operations: false, security: true };
    expect(shouldDeliverNotification("security_session_revoked", "in_app", preferences)).toBe(true);
    for (const kind of ["identity.recovery.delivery_requested", "identity.invitation.delivery_requested"]) {
      expect(shouldDeliverNotification(kind, "email", preferences)).toBe(true);
      expect(shouldDeliverNotification(kind, "in_app", preferences)).toBe(false);
    }
    expect(shouldDeliverNotification("language_updated", "email", preferences)).toBe(false);
    expect(shouldDeliverNotification("unknown", "in_app", preferences)).toBe(false);
  });
  it("rejects unknown channels/categories, identity injection, coercion, partial settings and security opt-outs", () => {
    const preferences = defaultNotificationPreferences();
    for (const input of [null, {}, { ...preferences, accountId: crypto.randomUUID() }, { ...preferences, push: {} },
      { ...preferences, email: { security: false } }, { ...preferences, email: { security: true, account: true } },
      { ...preferences, in_app: { ...preferences.in_app, security: false } },
      { ...preferences, in_app: { ...preferences.in_app, enabled: "false" } },
      { ...preferences, in_app: { ...preferences.in_app, revenue: true } }]) {
      expect(notificationPreferencesSchema.safeParse(input).success).toBe(false);
    }
  });
});
