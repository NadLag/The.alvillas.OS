import { z } from "zod";

export const routedNotificationKinds = ["lead_reminder", "language_updated", "task_assigned", "reservation_created", "task_completed", "task_overdue", "security_session_revoked", "approval_requested", "approval_decided", "staff_document_expiring", "document_expiring", "receivable_reminder", "ledger_integrity_failed"] as const;
export const routedNotificationKindSchema = z.enum(routedNotificationKinds);
export type RoutedNotificationKind = z.infer<typeof routedNotificationKindSchema>;
export const notificationRoutingSchema = z.object({
  roles: z.array(z.string().uuid()).max(100),
  people: z.array(z.string().uuid()).max(100),
  assigned: z.boolean(),
  channels: z.array(z.enum(["in_app", "email", "push"])).max(3)
}).strict();
export type NotificationRouting = z.infer<typeof notificationRoutingSchema>;
export const explicitNotificationRoutingSchema = notificationRoutingSchema.refine(value => !value.assigned && value.channels.length > 0 && value.people.length + value.roles.length > 0,
  "Explicit recipients and delivery channels are required");
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
}).strict().superRefine((value,ctx)=>{if(value.kind==="lead_reminder"){if(value.propertyId!==null)ctx.addIssue({code:"custom",path:["propertyId"],message:"Lead reminder routing requires organization scope"});if(!explicitNotificationRoutingSchema.safeParse(value.routing).success)ctx.addIssue({code:"custom",path:["routing"],message:"Explicit lead reminder recipients and delivery channels are required"});}if(value.kind==="document_expiring"){if(value.propertyId!==null)ctx.addIssue({code:"custom",path:["propertyId"],message:"Document expiry routing requires organization scope"});if(!explicitNotificationRoutingSchema.safeParse(value.routing).success)ctx.addIssue({code:"custom",path:["routing"],message:"Explicit document expiry recipients and delivery channels are required"});}if(value.kind==="receivable_reminder"){if(value.propertyId!==null)ctx.addIssue({code:"custom",path:["propertyId"],message:"Receivable reminder routing requires organization scope"});if(value.routing.assigned)ctx.addIssue({code:"custom",path:["routing","assigned"],message:"Receivable reminder recipients must be explicitly configured"});}if(value.kind==="ledger_integrity_failed"){if(value.propertyId!==null)ctx.addIssue({code:"custom",path:["propertyId"],message:"Integrity failure routing requires organization scope"});if(!explicitNotificationRoutingSchema.safeParse(value.routing).success)ctx.addIssue({code:"custom",path:["routing"],message:"Explicit integrity failure recipients and delivery channels are required"});}});
