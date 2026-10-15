import type { Notification, OutboxEvent } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { notificationEventType, notificationInputSchema, type NotificationCursor, type NotificationInput } from "./notification";

export class NotificationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async deliver(event: OutboxEvent): Promise<void> {
    if (event.organizationId !== this.organizationId || event.type !== notificationEventType) throw new Error("Invalid notification event");
    const input = notificationInputSchema.parse(event.payload);
    const recipient = await this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id: input.recipientId, status: "ACTIVE" }, select: { id: true } });
    if (!recipient) return;
    if (input.kind === "language_updated" && input.targetId !== input.recipientId) throw new Error("Invalid notification subject");
    if (input.kind === "task_assigned") {
      const task = await this.tx.operationTask.findFirst({ where: { organizationId: this.organizationId, id: input.targetId, assignedToUserAccountId: input.recipientId }, select: { id: true } });
      // An old event must not re-notify a former assignee.
      if (!task) return;
    }
    await this.tx.notification.createMany({ data: [{ organizationId: this.organizationId, recipientId: input.recipientId,
      eventId: event.id, kind: input.kind, targetId: input.targetId, createdAt: event.occurredAt }], skipDuplicates: true });
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
    await this.tx.outboxEvent.update({ where: { id: event.id, organizationId: this.organizationId },
      data: { status: "DISPATCHED", processedAt: new Date(), nextAttemptAt: null, lastError: null } });
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

  async targets(rows: Notification[]): Promise<Map<string, Resource>> {
    const ids = rows.filter((row) => row.kind === "task_assigned").map((row) => row.targetId);
    const tasks = ids.length ? await this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null },
      select: { id: true, propertyId: true, state: true, assignedToUserAccountId: true, property: { select: { regionId: true, cityId: true } } } }) : [];
    const targets = new Map<string, Resource>(tasks.map((task) => [task.id, {
      type: "task", organizationId: this.organizationId, id: task.id, taskId: task.id, jobId: task.id,
      propertyId: task.propertyId, region: task.property.regionId, city: task.property.cityId,
      status: task.state, assignedUserAccountId: task.assignedToUserAccountId
    }]));
    for (const row of rows) if (row.kind === "language_updated") targets.set(row.targetId, { type: "identity", organizationId: this.organizationId, id: row.targetId });
    return targets;
  }
}
