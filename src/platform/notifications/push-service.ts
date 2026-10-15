import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { pushConfiguration, validatePushRegistration } from "@/platform/providers/web-push";
import { notificationDestination, notificationInputSchema, notificationPageSchema } from "./notification";
import { assertInbox, NotificationAccessError, type NotificationActor } from "./notification-service";
import { NotificationRepository } from "./notification-repository";
import { PushRepository } from "./push-repository";
import { pushSubscriptionSchema } from "./web-push";
import { channelPayloadSchema, resolveNotificationChannel } from "./notification-channel-service";

type Deps = { db?: TenantTransactionRunner; env?: Record<string, string | undefined>; requestId?: string };
export async function pushSettings(actor: NotificationActor, input: unknown = {}, deps: Deps = {}) {
  assertInbox(actor, "view"); const { cursor } = notificationPageSchema.parse(input);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new PushRepository(tx, actor.organizationId);
    if (!await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId)) throw new NotificationAccessError();
    const [subscriptions, history] = await Promise.all([repository.subscriptions(actor.accountId), repository.history(actor.accountId,
      cursor ? { ...cursor, createdAt: new Date(cursor.createdAt) } : undefined)]);
    const config = pushConfiguration(deps.env ?? process.env);
    const items = history.slice(0, 20); const last = items.at(-1);
    const env = deps.env ?? process.env;
    return { publicKey: config?.publicKey ?? null, deliveryReady: Boolean(config && env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY),
      subscriptions: subscriptions.filter((row) => !config || row.vapidPublicKey === config.publicKey).map((row) => ({ id: row.id, currentSession: row.sessionId === actor.sessionId, createdAt: row.createdAt.toISOString() })),
      items: items.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        acceptedAt: row.acceptedAt?.toISOString() ?? null, displayedAt: row.displayedAt?.toISOString() ?? null, openedAt: row.openedAt?.toISOString() ?? null })),
      nextCursor: history.length > 20 && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
  });
}
export async function savePushSubscription(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  assertInbox(actor, "edit"); const subscription = pushSubscriptionSchema.parse(input);
  const sessionId = z.string().uuid().parse(actor.sessionId);
  if (subscription.expirationTime && subscription.expirationTime <= Date.now()) throw new NotificationAccessError();
  const config = pushConfiguration(deps.env ?? process.env);
  if (!config) throw new Error("Web push is not configured");
  try { validatePushRegistration(subscription, config); } catch { throw new NotificationAccessError(); }
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    if (!await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId, true)) throw new NotificationAccessError();
    const saved = await new PushRepository(tx, actor.organizationId).save(actor.accountId, sessionId, subscription, config.publicKey);
    if (saved.changed) await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "notification.push.subscribe", resourceType: "notification", resourceId: saved.id,
      before: null, after: { enabled: true }, reason: null, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: new Date() });
    return { id: saved.id };
  });
}
export async function revokePushSubscription(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  assertInbox(actor, "edit");
  const parsed = z.object({ id: z.string().uuid().nullable(), reason: z.enum(["user_disabled", "permission_revoked", "subscription_changed", "logout"]) }).strict().parse(input);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const result = await new PushRepository(tx, actor.organizationId).revoke(actor.accountId, parsed.id, parsed.reason,
      parsed.id === null ? z.string().uuid().parse(actor.sessionId) : undefined);
    if (result.count) await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "notification.push.revoke", resourceType: "notification", resourceId: parsed.id ?? actor.accountId,
      before: null, after: { revoked: result.count }, reason: parsed.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: new Date() });
  });
}
export async function pushRecord(actor: NotificationActor, id: string, operation: "display" | "displayed" | "open", deps: Deps = {}) {
  assertInbox(actor, operation === "display" ? "view" : "edit"); z.string().uuid().parse(id);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new PushRepository(tx, actor.organizationId);
    const row = await repository.lockedDelivery(id);
    if (!row || row.userAccountId !== actor.accountId || row.status !== "ACCEPTED") throw new NotificationAccessError();
    if (operation === "display" && (row.displayedAt || row.openedAt)) throw new NotificationAccessError();
    const notifications = new NotificationRepository(tx, actor.organizationId);
    const event = await notifications.channelEvent(row.eventId);
    if (!event) throw new NotificationAccessError();
    const payload = channelPayloadSchema.parse(event.payload);
    const input = notificationInputSchema.parse({ kind: payload.kind, targetId: payload.targetId, recipientId: payload.recipientId });
    const context = await resolveNotificationChannel(notifications, payload);
    const destination = notificationDestination(actor.authContext, input, context.target ?? null, context.locale);
    if (!context.candidate || !destination || (operation !== "open" && !context.allowed)) throw new NotificationAccessError();
    if (operation !== "open") {
      const subscription = row.subscriptionId ? await repository.subscription(row.subscriptionId) : null;
      if (!subscription || subscription.revokedAt || subscription.sessionId !== actor.sessionId || subscription.session.revokedAt
        || subscription.session.expiresAt <= new Date()) throw new NotificationAccessError();
      if (operation === "displayed" && !row.displayedAt) await repository.updateDelivery(id, { displayedAt: new Date() });
    } else {
      if (!row.openedAt) await repository.updateDelivery(id, { openedAt: new Date() });
      const page = payload.sourceEventId ? await notifications.findSource(actor.accountId, payload.sourceEventId) : null;
      if (page && !page.readAt) {
        const now = new Date(); await notifications.markRead(actor.accountId, page.id, now);
        await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "notification.read", resourceType: "notification", resourceId: page.id,
          before: { readAt: null }, after: { readAt: now.toISOString() }, reason: null, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
      }
    }
    return { title: context.labels.kinds[input.kind], body: context.labels.open, url: destination, locale: context.locale };
  });
}
