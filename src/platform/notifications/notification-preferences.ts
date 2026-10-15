import { z } from "zod";

// Only channels with an existing delivery path are permitted. Security policy is
// server-owned; neither a channel switch nor a category switch can override it.
export const notificationPreferencesSchema = z.object({
  in_app: z.object({ enabled: z.boolean(), account: z.boolean(), operations: z.boolean(), security: z.literal(true) }).strict(),
  email: z.object({ security: z.literal(true), enabled: z.boolean().optional(), account: z.boolean().optional(), operations: z.boolean().optional() }).strict().refine((value) => [value.enabled, value.account, value.operations].every((item) => item === undefined) || [value.enabled, value.account, value.operations].every((item) => typeof item === "boolean")),
  push: z.object({ enabled: z.boolean(), account: z.boolean(), operations: z.boolean() }).strict().optional()
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export function defaultNotificationPreferences(): NotificationPreferences {
  return { in_app: { enabled: true, account: true, operations: true, security: true }, email: { security: true } };
}

export function shouldDeliverNotification(kind: string, channel: "in_app" | "email" | "push", preferences: NotificationPreferences | null): boolean {
  if (kind === "security_session_revoked") return channel === "in_app";
  if (kind === "identity.invitation.delivery_requested" || kind === "identity.recovery.delivery_requested") return channel === "email";
  const value = preferences ?? defaultNotificationPreferences();
  const settings = channel === "in_app" ? value.in_app : value[channel];
  if (!settings?.enabled) return false;
  if (kind === "language_updated") return settings.account ?? false;
  if (kind === "task_assigned" || kind === "task_completed" || kind === "reservation_created" || kind === "approval_requested" || kind === "approval_decided") return settings.operations ?? false;
  return false;
}
