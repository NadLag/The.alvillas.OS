import { z } from "zod";

export const routedNotificationKinds = ["language_updated", "task_assigned", "reservation_created", "task_completed", "task_overdue", "security_session_revoked", "approval_requested", "approval_decided", "staff_document_expiring"] as const;
export const routedNotificationKindSchema = z.enum(routedNotificationKinds);
export type RoutedNotificationKind = z.infer<typeof routedNotificationKindSchema>;
export const notificationRoutingSchema = z.object({
  roles: z.array(z.string().uuid()).max(100),
  people: z.array(z.string().uuid()).max(100),
  assigned: z.boolean(),
  channels: z.array(z.enum(["in_app", "email", "push"])).max(3)
}).strict();
export type NotificationRouting = z.infer<typeof notificationRoutingSchema>;
export function notificationRoutingKey(kind: RoutedNotificationKind) { return `notification.routing.${kind}`; }

// Initial values are persisted as ordinary config_rule versions before use.
// No operational/administrative role receives events implicitly.
export function initialNotificationRouting(kind: RoutedNotificationKind): NotificationRouting {
  return { roles: [], people: [], assigned: kind === "language_updated" || kind === "task_assigned" || kind === "task_overdue" || kind === "approval_decided", channels: ["in_app"] };
}
export const notificationRoutingSaveSchema = z.object({
  kind: routedNotificationKindSchema,
  propertyId: z.string().uuid().nullable(),
  routing: notificationRoutingSchema,
  reason: z.string().trim().min(6).max(500)
}).strict();
