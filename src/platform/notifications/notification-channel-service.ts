import { Prisma, type OutboxEvent } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { NotificationChannel } from "@/platform/providers";
import { authorize } from "@/platform/authz/authorize";
import { contextForRoleAssignments } from "@/platform/authz/account-context";
import { securityEnrollment } from "@/platform/auth/security-enrollment";
import { safeLocale } from "@/i18n/routing";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import ar from "../../../messages/ar.json";
import { NotificationRepository } from "./notification-repository";
import { notificationInputSchema, notificationDestination } from "./notification";
import { shouldDeliverNotification } from "./notification-preferences";

export const notificationChannelEventType = "notification.channel.requested";
export async function deliverNotificationChannel(event: OutboxEvent, deps: {
  db?: TenantTransactionRunner; channels: Partial<Record<"email" | "push", NotificationChannel>>; appUrl: string;
}) {
  return withTenant(deps.db ?? prisma, event.organizationId, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM outbox_event WHERE organization_id = ${event.organizationId}::uuid AND id = ${event.id}::uuid FOR UPDATE`);
    const stored = await tx.outboxEvent.findFirst({ where: { organizationId: event.organizationId, id: event.id, type: notificationChannelEventType } });
    if (!stored || stored.status === "DISPATCHED") return;
    const payload = z.object({ channel: z.enum(["email", "push"]), recipientId: z.string().uuid(), kind: z.string(), targetId: z.string().uuid() }).strict().parse(stored.payload);
    const input = notificationInputSchema.parse({ kind: payload.kind, recipientId: payload.recipientId, targetId: payload.targetId });
    const repository = new NotificationRepository(tx, event.organizationId);
    const candidate = await repository.channelRecipient(input.recipientId);
    const target = (await repository.targets([input])).get(input.targetId);
    const preferences = await repository.preferences(input.recipientId);
    const ctx = candidate ? contextForRoleAssignments(event.organizationId, candidate.id, candidate.roleAssignments) : null;
    const locale = safeLocale(candidate?.person.preferredLocale ?? "en");
    const destination = ctx && target ? notificationDestination(ctx, input, target, locale) : null;
    const allowed = candidate && ctx && target && destination && !securityEnrollment(candidate).setupRequired && (target.type === "identity" || authorize(ctx, "view", target))
      && (input.kind !== "approval_requested" || (target.status === "PENDING" && (authorize(ctx, "approve", target) || authorize(ctx, "reject", target))))
      && shouldDeliverNotification(input.kind, payload.channel, preferences);
    if (allowed) {
      const channel = deps.channels[payload.channel];
      if (!channel) throw new Error(`Notification ${payload.channel} provider is not configured`);
      const address = payload.channel === "email" ? candidate.email : candidate.id;
      if (!address) throw new Error("Notification recipient has no channel address");
      const labels = { en, fr, ar }[locale].Notifications;
      const origin = new URL(deps.appUrl);
      if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) throw new Error("Invalid notification origin");
      try {
        const result = await channel.notify({ userId: address, subject: labels.kinds[input.kind], body: `${labels.open}: ${new URL(destination, origin).href}`, locale,
          idempotencyKey: `notification:${event.organizationId}:${event.id}` });
        if (!result.id) throw new Error("Missing provider acknowledgement");
      } catch { throw new Error(`Notification ${payload.channel} provider did not acknowledge delivery`); }
    }
    await tx.outboxEvent.update({ where: { id: stored.id, organizationId: event.organizationId }, data: { status: "DISPATCHED", processedAt: new Date(), lastError: null, nextAttemptAt: null } });
  });
}
