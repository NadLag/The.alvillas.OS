import type { Session } from "next-auth";
import type { OutboxEvent } from "@prisma/client";
import { authContextForAccount } from "@/platform/authz/account-context";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { NotificationRepository } from "./notification-repository";
import { notificationDestination, notificationInputSchema, notificationPageSchema, ownNotificationContext,
  type NotificationInput, type NotificationPage } from "./notification";
import { z } from "zod";
import { notificationPreferencesSchema, type NotificationPreferences } from "./notification-preferences";
import { notificationRoutingKey, notificationRoutingSaveSchema, routedNotificationKindSchema } from "./notification-routing";

export type NotificationActor = { organizationId: string; accountId: string; authContext: AuthContext };
type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class NotificationAccessError extends Error {}

export async function notificationActorFromSession(session: Session | null): Promise<NotificationActor | null> {
  const user = session?.user;
  if (!user?.id || !user.organizationId || user.securitySetupRequired) return null;
  const ctx = await authContextForAccount(user.organizationId, user.id);
  return { organizationId: user.organizationId, accountId: user.id, authContext: ownNotificationContext(ctx, user.id) };
}

function assertInbox(actor: NotificationActor, action: "view" | "edit") {
  if (actor.accountId !== actor.authContext.userAccountId || !authorize(actor.authContext, action, {
    type: "notification", organizationId: actor.organizationId, id: actor.accountId
  })) throw new NotificationAccessError();
}

export async function getNotificationPreferences(actor: NotificationActor, deps: Deps = {}): Promise<NotificationPreferences> {
  assertInbox(actor, "view");
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new NotificationRepository(tx, actor.organizationId);
    if (!await repository.activeRecipient(actor.accountId)) throw new NotificationAccessError();
    const preferences = await repository.preferences(actor.accountId);
    return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", {
      type: "notification", organizationId: actor.organizationId, id: actor.accountId, data: { preferences }
    }, {}).preferences as NotificationPreferences;
  });
}

export async function saveNotificationPreferences(actor: NotificationActor, input: unknown, deps: Deps = {}): Promise<NotificationPreferences> {
  assertInbox(actor, "edit");
  const preferences = notificationPreferencesSchema.parse(input);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new NotificationRepository(tx, actor.organizationId);
    if (!await repository.activeRecipient(actor.accountId, true)) throw new NotificationAccessError();
    const before = await repository.preferences(actor.accountId);
    await repository.savePreferences(actor.accountId, preferences);
    if (JSON.stringify(before) !== JSON.stringify(preferences)) await writeAuditEvent(tx, {
      organizationId: actor.organizationId, actorId: actor.accountId, action: "notification.preferences.update", resourceType: "notification", resourceId: actor.accountId,
      before: { inApp: before.in_app, emailSecurity: before.email.security, emailSettings: before.email, push: before.push ?? null }, after: { inApp: preferences.in_app, emailSecurity: preferences.email.security, emailSettings: preferences.email, push: preferences.push ?? null },
      reason: null, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: new Date()
    });
    return preferences;
  });
}

export async function publishNotification(tx: TenantTransaction, organizationId: string, input: NotificationInput, key: string) {
  await new NotificationRepository(tx, organizationId).publish(input, key);
}
export async function deliverNotificationEvent(event: OutboxEvent, deps: Deps = {}) {
  return withTenant(deps.db ?? prisma, event.organizationId, (tx) => new NotificationRepository(tx, event.organizationId).deliver(event));
}

export async function getNotificationRouting(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  const parsed = z.object({ kind: routedNotificationKindSchema, propertyId: z.string().uuid().nullable() }).strict().parse(input);
  if (actor.accountId !== actor.authContext.userAccountId || actor.authContext.organizationId !== actor.organizationId || !authorize(actor.authContext, "configure", {
    type: "config_rule", organizationId: actor.organizationId
  })) throw new NotificationAccessError();
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new NotificationRepository(tx, actor.organizationId);
    await repository.validateRoutingReferences({ roles: [], people: [], assigned: false, channels: [] }, parsed.propertyId);
    const options = await repository.routingOptions();
    return { routing: await repository.routing(parsed.kind, parsed.propertyId),
      roles: options.roles, people: options.people,
      properties: options.properties.filter((property) => authorize(actor.authContext, "configure", { type: "config_rule", organizationId: actor.organizationId, propertyId: property.id })) };
  });
}

export async function saveNotificationRouting(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  const parsed = notificationRoutingSaveSchema.parse(input);
  if (actor.accountId !== actor.authContext.userAccountId || actor.authContext.organizationId !== actor.organizationId || !authorize(actor.authContext, "configure", {
    type: "config_rule", organizationId: actor.organizationId
  })) throw new NotificationAccessError();
  const { createConfigRuleVersion } = await import("@/modules/config/application/config-service");
  await createConfigRuleVersion({ organizationId: actor.organizationId, actorId: actor.accountId, personId: actor.authContext.personId ?? actor.accountId, authContext: actor.authContext }, {
    key: notificationRoutingKey(parsed.kind), scopeType: parsed.propertyId ? "property" : "organization", scopeId: parsed.propertyId ?? undefined,
    lifecycle: "ACTIVE", valueJson: JSON.stringify(parsed.routing), effectiveFrom: new Date(), reason: parsed.reason
  }, { db: deps.db, requestId: deps.requestId ?? crypto.randomUUID() });
  return parsed.routing;
}

export async function getNotificationPage(actor: NotificationActor, input: unknown = {}, deps: Deps = {}): Promise<NotificationPage> {
  const { cursor } = notificationPageSchema.parse(input);
  assertInbox(actor, "view");
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new NotificationRepository(tx, actor.organizationId);
    const [rows, unreadCount] = await Promise.all([repository.page(actor.accountId, cursor), repository.unreadCount(actor.accountId)]);
    const visible = rows.slice(0, 20);
    const targets = await repository.targets(visible);
    const last = visible.at(-1);
    return { unreadCount, nextCursor: rows.length > 20 && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      items: visible.map((row) => {
        const input = notificationInputSchema.parse({ kind: row.kind, targetId: row.targetId, recipientId: row.recipientId });
        const data = { id: row.id, kind: input.kind, createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null,
          available: Boolean(notificationDestination(actor.authContext, input, targets.get(row.targetId) ?? null, "en")), ...(row.resolution ? { resolution: row.resolution } : {}) };
        return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", {
          type: "notification", organizationId: actor.organizationId, id: actor.accountId, data
        }, {}) as typeof data;
      }) };
  }, { isolationLevel: "RepeatableRead" });
}

export async function readNotification(actor: NotificationActor, id: string, deps: Deps = {}): Promise<void> {
  z.string().uuid().parse(id);
  assertInbox(actor, "edit");
  await withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new NotificationRepository(tx, actor.organizationId);
    const row = await repository.find(actor.accountId, id);
    if (!row) throw new NotificationAccessError();
    const now = new Date();
    const changed = await repository.markRead(actor.accountId, id, now);
    if (changed.count) await writeAuditEvent(tx, {
      organizationId: actor.organizationId, actorId: actor.accountId, action: "notification.read", resourceType: "notification", resourceId: id,
      before: { readAt: null }, after: { readAt: now.toISOString() }, reason: null, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now
    });
  });
}

export async function openNotification(actor: NotificationActor, id: string, locale: "en" | "fr" | "ar", deps: Deps = {}): Promise<string> {
  z.string().uuid().parse(id);
  assertInbox(actor, "view");
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new NotificationRepository(tx, actor.organizationId);
    const row = await repository.find(actor.accountId, id);
    if (!row) throw new NotificationAccessError();
    const input = notificationInputSchema.parse({ kind: row.kind, targetId: row.targetId, recipientId: row.recipientId });
    const targets = await repository.targets([row]);
    const destination = notificationDestination(actor.authContext, input, targets.get(row.targetId) ?? null, locale);
    if (!destination) throw new NotificationAccessError();
    return destination;
  });
}
