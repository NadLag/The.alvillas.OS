import { z } from "zod";
import { authorize } from "@/platform/authz/authorize";
import { contextForRoleAssignments } from "@/platform/authz/account-context";
import { securityEnrollment } from "@/platform/auth/security-enrollment";
import { safeLocale } from "@/i18n/routing";
import en from "../../../messages/en.json" with { type: "json" };
import fr from "../../../messages/fr.json" with { type: "json" };
import ar from "../../../messages/ar.json" with { type: "json" };
import type { NotificationRepository } from "./notification-repository";
import { notificationInputSchema, notificationDestination } from "./notification";
import { shouldDeliverNotification } from "./notification-preferences";

export const notificationChannelEventType = "notification.channel.requested";
export const channelPayloadSchema = z.object({ channel: z.enum(["email", "push"]), recipientId: z.string().uuid(), kind: z.string(), targetId: z.string().uuid(), sourceEventId: z.string().uuid().optional() }).strict();
export async function resolveNotificationChannel(repository: NotificationRepository, payload: z.infer<typeof channelPayloadSchema>) {
  const input = notificationInputSchema.parse({ kind: payload.kind, recipientId: payload.recipientId, targetId: payload.targetId });
  const candidate = await repository.channelRecipient(input.recipientId);
  const target = (await repository.targets([input])).get(input.targetId);
  const preferences = await repository.preferences(input.recipientId);
  const ctx = candidate ? contextForRoleAssignments(candidate.organizationId, candidate.id, candidate.roleAssignments) : null;
  const locale = safeLocale(candidate?.person.preferredLocale ?? "en");
  const destination = ctx && target ? notificationDestination(ctx, input, target, locale) : null;
  const allowed = Boolean(candidate && ctx && target && destination && (target.type === "identity" || !securityEnrollment(candidate).setupRequired)
    && (target.type === "identity" || authorize(ctx, "view", target))
    && (input.kind !== "approval_requested" || (target.status === "PENDING" && (authorize(ctx, "approve", target) || authorize(ctx, "reject", target))))
    && shouldDeliverNotification(input.kind, payload.channel, preferences));
  return { input, candidate, target, locale, destination, allowed, labels: { en, fr, ar }[locale].Notifications };
}
