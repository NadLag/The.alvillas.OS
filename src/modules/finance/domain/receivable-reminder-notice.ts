import {z} from "zod";
import {notificationRoutingSchema} from "@/platform/notifications/notification-routing";

/** Notification payloads carry provenance and routing, never guest names or financial amounts. */
export const receivableReminderNoticeSchema=z.object({assignmentId:z.uuid(),policyId:z.uuid(),routingRuleId:z.uuid(),on:z.iso.date(),occurrenceOn:z.iso.date(),stage:z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u),currency:z.string().regex(/^[A-Z]{3}$/u),routing:notificationRoutingSchema}).strict();
export type ReceivableReminderNotice=z.infer<typeof receivableReminderNoticeSchema>;
