import type { Notification, OutboxEvent } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { notificationEventType, notificationInputSchema, type NotificationCursor, type NotificationInput } from "./notification";
import { Prisma } from "@prisma/client";
import { defaultNotificationPreferences, shouldDeliverNotification, type NotificationPreferences } from "./notification-preferences";
import { authorize } from "@/platform/authz/authorize";
import { securityEnrollment } from "@/platform/auth/security-enrollment";
import { contextForRoleAssignments } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { initialNotificationRouting, notificationRoutingKey, notificationRoutingSchema, type NotificationRouting, type RoutedNotificationKind } from "./notification-routing";

export class NotificationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async activeRecipient(accountId: string, lock = false) {
    if (lock) await this.tx.$queryRaw(Prisma.sql`SELECT id FROM user_account WHERE organization_id = ${this.organizationId}::uuid AND id = ${accountId}::uuid FOR UPDATE`);
    return this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id: accountId, status: "ACTIVE" }, select: { id: true } });
  }

  async preferences(accountId: string): Promise<NotificationPreferences> {
    const row = await this.tx.notificationPreference.findUnique({ where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } } });
    return this.preferenceValue(row);
  }

  savePreferences(accountId: string, preferences: NotificationPreferences) {
    const data = { inAppEnabled: preferences.in_app.enabled, inAppAccount: preferences.in_app.account, inAppOperations: preferences.in_app.operations, inAppSecurity: true, emailSecurity: true };
    return this.tx.notificationPreference.upsert({
      where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } },
      create: { organizationId: this.organizationId, userAccountId: accountId, ...data }, update: data
    });
  }

  async deliver(event: OutboxEvent): Promise<void> {
    if (event.organizationId !== this.organizationId || event.type !== notificationEventType) throw new Error("Invalid notification event");
    // Serialize every delivery decision (including suppression) on the durable source.
    // Replays must re-read its status rather than trust a stale caller's event object.
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM outbox_event WHERE organization_id = ${this.organizationId}::uuid AND id = ${event.id}::uuid FOR UPDATE`);
    const stored = await this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id: event.id, type: notificationEventType } });
    if (!stored || stored.status === "DISPATCHED") return;
    event = stored;
    const input = notificationInputSchema.parse(event.payload);
    const target = (await this.targets([{ kind: input.kind, targetId: input.targetId }])).get(input.targetId);
    if (!target) return this.finish(event.id);
    if (input.kind === "task_assigned" && target.assignedUserAccountId !== input.recipientId) return this.finish(event.id);
    const identity = target.type === "identity";
    if (identity && input.targetId !== input.recipientId) throw new Error("Invalid notification subject");
    const routing = await this.routing(input.kind, target.propertyId ?? null, event.occurredAt);
    const mandatory = input.kind === "security_session_revoked";
    const assignedId = identity ? input.targetId : target.assignedUserAccountId;
    const candidates = await this.candidates(routing, (mandatory || routing.assigned) ? assignedId : null);
    const data = [];
    for (const candidate of candidates) {
      // Account notices never reveal one person's security/account activity to another.
      if (identity && candidate.id !== input.targetId) continue;
      const selected = (mandatory || routing.assigned) && candidate.id === assignedId;
      const explicit = routing.people.includes(candidate.personId);
      const roleAssignments = candidate.roleAssignments.filter((assignment) => routing.roles.includes(assignment.role.id));
      const ctx = contextForRoleAssignments(this.organizationId, candidate.id, explicit || selected ? candidate.roleAssignments : roleAssignments);
      if (!identity && securityEnrollment(candidate).setupRequired) continue;
      if (!identity && !authorize(ctx, "view", target)) continue;
      if (!mandatory && (!routing.channels.includes("in_app") || !shouldDeliverNotification(input.kind, "in_app", this.preferenceValue(candidate.notificationPreference)))) continue;
      data.push({ organizationId: this.organizationId, recipientId: candidate.id,
        eventId: event.id, kind: input.kind, targetId: input.targetId, createdAt: event.occurredAt });
    }
    if (data.length) await this.tx.notification.createMany({ data, skipDuplicates: true });
    await this.finish(event.id);
  }

  private finish(id: string) {
    return this.tx.outboxEvent.update({ where: { id, organizationId: this.organizationId }, data: { status: "DISPATCHED", processedAt: new Date(), nextAttemptAt: null, lastError: null } }).then(() => undefined);
  }

  private preferenceValue(row: { inAppEnabled: boolean; inAppAccount: boolean; inAppOperations: boolean } | null): NotificationPreferences {
    return row ? { in_app: { enabled: row.inAppEnabled, account: row.inAppAccount, operations: row.inAppOperations, security: true }, email: { security: true } } : defaultNotificationPreferences();
  }

  private candidates(routing: NotificationRouting, assignedId?: string | null) {
    const now = new Date();
    return this.tx.userAccount.findMany({ where: { organizationId: this.organizationId, status: "ACTIVE", person: { archivedAt: null }, OR: [
      ...(assignedId ? [{ id: assignedId }] : []), { personId: { in: routing.people } },
      { roleAssignments: { some: { organizationId: this.organizationId, archivedAt: null, roleId: { in: routing.roles }, role: { archivedAt: null }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } } }
    ] }, include: { authCredentials: { where: { revokedAt: null }, select: { type: true, expiresAt: true, revokedAt: true } }, notificationPreference: true, roleAssignments: { where: {
      organizationId: this.organizationId, archivedAt: null, role: { archivedAt: null }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }]
    }, include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } } });
  }

  async routing(kind: RoutedNotificationKind, propertyId: string | null, asOf = new Date()): Promise<NotificationRouting> {
    const repository = new ConfigRuleRepository(this.tx, this.organizationId);
    const key = notificationRoutingKey(kind);
    let resolved = await repository.resolve({ key, asOf, scopes: [
      ...(propertyId ? [{ scopeType: "property", scopeId: propertyId }] : []), { scopeType: "organization", scopeId: null }
    ] });
    if (!resolved) {
      // A single tenant lock makes concurrent first-use initialization retry-safe.
      await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + key}, 0))::text`);
      const versions = await repository.list({ key, scopeType: "organization", scopeId: null, take: 1 });
      if (!versions.length) {
        await repository.createVersion({ key, scopeType: "organization", value: initialNotificationRouting(kind), effectiveFrom: new Date(0), reason: "Initialize configurable notification routing" });
        resolved = await repository.resolve({ key, asOf, scopes: [{ scopeType: "organization", scopeId: null }] });
      }
    }
    // An inactive/retired/future rule is an explicit absence, never a fallback recipient list.
    return resolved ? notificationRoutingSchema.parse(resolved.parsedValue) : { roles: [], people: [], assigned: false, channels: [] };
  }

  async routingOptions() {
    const [roles, people, properties] = await Promise.all([
      this.tx.role.findMany({ where: { organizationId: this.organizationId, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      this.tx.person.findMany({ where: { organizationId: this.organizationId, archivedAt: null, userAccounts: { some: { status: "ACTIVE" } } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
      new ConfigRuleRepository(this.tx, this.organizationId).listPropertyScopeOptions()
    ]);
    return { roles, people, properties };
  }

  async validateRoutingReferences(routing: NotificationRouting, propertyId: string | null) {
    const [roles, people, property] = await Promise.all([
      this.tx.role.count({ where: { organizationId: this.organizationId, id: { in: routing.roles }, archivedAt: null } }),
      this.tx.person.count({ where: { organizationId: this.organizationId, id: { in: routing.people }, archivedAt: null, userAccounts: { some: { status: "ACTIVE" } } } }),
      propertyId ? this.tx.property.count({ where: { organizationId: this.organizationId, id: propertyId, archivedAt: null } }) : Promise.resolve(1)
    ]);
    if (!property || roles !== new Set(routing.roles).size || people !== new Set(routing.people).size) throw new Error("Invalid routing references");
  }

  async publish(input: NotificationInput, idempotencyKey: string): Promise<void> {
    const parsed = notificationInputSchema.parse(input);
    const event = await this.tx.outboxEvent.upsert({
      where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, update: {},
      create: { organizationId: this.organizationId, type: notificationEventType, payload: parsed, idempotencyKey }
    });
    // Local durable delivery is atomic with the business change. Outbox replay is safe
    // and does not depend on an external email/job provider being configured.
    await this.deliver(event);
  }

  page(recipientId: string, cursor?: NotificationCursor | null) {
    return this.tx.notification.findMany({ where: { organizationId: this.organizationId, recipientId,
      ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
  }
  unreadCount(recipientId: string) {
    return this.tx.notification.count({ where: { organizationId: this.organizationId, recipientId, readAt: null } });
  }
  find(recipientId: string, id: string) {
    return this.tx.notification.findFirst({ where: { organizationId: this.organizationId, recipientId, id } });
  }
  markRead(recipientId: string, id: string, readAt: Date) {
    return this.tx.notification.updateMany({ where: { organizationId: this.organizationId, recipientId, id, readAt: null }, data: { readAt } });
  }

  async targets(rows: Pick<Notification, "kind" | "targetId">[]): Promise<Map<string, Resource>> {
    const ids = rows.filter((row) => row.kind === "task_assigned" || row.kind === "task_completed").map((row) => row.targetId);
    const tasks = ids.length ? await this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null },
      select: { id: true, propertyId: true, state: true, assignedToUserAccountId: true, property: { select: { regionId: true, cityId: true } } } }) : [];
    const targets = new Map<string, Resource>(tasks.map((task) => [task.id, {
      type: "task", organizationId: this.organizationId, id: task.id, taskId: task.id, jobId: task.id,
      propertyId: task.propertyId, region: task.property.regionId, city: task.property.cityId,
      status: task.state, assignedUserAccountId: task.assignedToUserAccountId
    }]));
    for (const row of rows) if (row.kind === "language_updated" || row.kind === "security_session_revoked") targets.set(row.targetId, { type: "identity", organizationId: this.organizationId, id: row.targetId });
    const reservationIds = rows.filter((row) => row.kind === "reservation_created").map((row) => row.targetId);
    const reservations = reservationIds.length ? await this.tx.reservation.findMany({ where: { organizationId: this.organizationId, id: { in: reservationIds }, archivedAt: null }, select: { id: true, propertyId: true, status: true, property: { select: { regionId: true, cityId: true } } } }) : [];
    for (const row of reservations) targets.set(row.id, { type: "reservation", organizationId: this.organizationId, id: row.id, reservationId: row.id, propertyId: row.propertyId, region: row.property.regionId, city: row.property.cityId, status: row.status });
    return targets;
  }
}
