import { z } from "zod";

// Only channels with an existing delivery path are permitted. Security policy is
// server-owned; neither a channel switch nor a category switch can override it.
export const notificationPreferencesSchema = z.object({
  in_app: z.object({ enabled: z.boolean(), account: z.boolean(), operations: z.boolean(), security: z.literal(true) }).strict(),
  email: z.object({ security: z.literal(true) }).strict()
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export function defaultNotificationPreferences(): NotificationPreferences {
  return { in_app: { enabled: true, account: true, operations: true, security: true }, email: { security: true } };
}

export function shouldDeliverNotification(kind: string, channel: "in_app" | "email", preferences: NotificationPreferences | null): boolean {
  if (kind === "security_session_revoked") return channel === "in_app";
  if (kind === "identity.invitation.delivery_requested" || kind === "identity.recovery.delivery_requested") return channel === "email";
  if (channel !== "in_app") return false;
  const settings = (preferences ?? defaultNotificationPreferences()).in_app;
  if (!settings.enabled) return false;
  if (kind === "language_updated") return settings.account;
  if (kind === "task_assigned") return settings.operations;
  return false;
}
