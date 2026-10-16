import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { digestEventType, digestPolicyKey, digestPolicySchema, initialDigestPolicy, operationalDigestKinds } from "./digest";

export class DigestRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  timezone() { return this.tx.organizationProfile.findUnique({ where: { organizationId: this.organizationId }, select: { timezone: true } }); }
  due(now: Date) {
    return this.tx.notificationPreference.findMany({ where: { organizationId: this.organizationId, digestNextAt: { lte: now }, emailEnabled: true, emailOperations: true },
      select: { userAccountId: true }, orderBy: [{ digestNextAt: "asc" }, { userAccountId: "asc" }], take: 100 });
  }
  preference(accountId: string) { return this.tx.notificationPreference.findUnique({ where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } } }); }
  advance(accountId: string, nextAt: Date | null) { return this.tx.notificationPreference.update({ where: { organizationId_userAccountId: { organizationId: this.organizationId, userAccountId: accountId } }, data: { digestNextAt: nextAt } }); }
  async policy(now: Date) {
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + digestPolicyKey}, 0))::text`);
    if (!(await config.list({ key: digestPolicyKey, scopeType: "organization", scopeId: null, take: 1 })).length) await config.createVersion({ key: digestPolicyKey, scopeType: "organization", value: initialDigestPolicy, effectiveFrom: new Date(0), reason: "Initialize configurable notification digest policy" });
    const resolved = await config.resolve({ key: digestPolicyKey, asOf: now, scopes: [{ scopeType: "organization", scopeId: null }] });
    return resolved ? digestPolicySchema.parse(resolved.parsedValue) : null;
  }
  unread(accountId: string, now: Date, after?: { createdAt: Date; id: string }) {
    return this.tx.notification.findMany({ where: { organizationId: this.organizationId, recipientId: accountId, readAt: null, resolvedAt: null,
      digestDeliveryId: null, kind: { in: [...operationalDigestKinds] }, createdAt: { lte: now },
      ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}) },
      select: { id: true, kind: true, targetId: true, recipientId: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 });
  }
  items(accountId: string, deliveryId: string) {
    return this.tx.notification.findMany({ where: { organizationId: this.organizationId, recipientId: accountId, digestDeliveryId: deliveryId, readAt: null, resolvedAt: null },
      select: { id: true, kind: true, targetId: true, recipientId: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  }
  async enqueue(accountId: string, revision: number, scheduledAt: Date, ids: string[]) {
    const key = `digest:${accountId}:${revision}:${scheduledAt.toISOString()}`;
    const event = await this.tx.outboxEvent.upsert({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey: key } }, update: {},
      create: { organizationId: this.organizationId, type: digestEventType, payload: { recipientId: accountId, revision, scheduledAt: scheduledAt.toISOString() }, idempotencyKey: key } });
    const delivery = await this.tx.notificationDelivery.upsert({ where: { organizationId_eventId_deliveryKey: { organizationId: this.organizationId, eventId: event.id, deliveryKey: "digest" } }, update: {},
      create: { organizationId: this.organizationId, userAccountId: accountId, eventId: event.id, channel: "digest", kind: "digest", deliveryKey: "digest", scheduledAt } });
    await this.tx.notification.updateMany({ where: { organizationId: this.organizationId, recipientId: accountId, id: { in: ids }, digestDeliveryId: null }, data: { digestDeliveryId: delivery.id } });
    return delivery;
  }
  event(id: string) { return this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id, type: digestEventType } }); }
  async lockedDelivery(eventId: string, accountId: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM notification_delivery WHERE organization_id = ${this.organizationId}::uuid AND event_id = ${eventId}::uuid AND user_account_id = ${accountId}::uuid AND channel = 'digest' FOR UPDATE`);
    return this.tx.notificationDelivery.findFirst({ where: { organizationId: this.organizationId, eventId, userAccountId: accountId, channel: "digest" } });
  }
  update(id: string, data: Prisma.NotificationDeliveryUpdateManyMutationInput) { return this.tx.notificationDelivery.updateMany({ where: { organizationId: this.organizationId, id, channel: "digest" }, data }); }
  history(accountId: string, before?: { createdAt: Date; id: string }) {
    return this.tx.notificationDelivery.findMany({ where: { organizationId: this.organizationId, userAccountId: accountId, channel: "digest",
      ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}) },
      select: { id: true, status: true, scheduledAt: true, attemptCount: true, nextAttemptAt: true, acceptedAt: true, deliveredAt: true, errorCode: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
  }
  async receiptDelivery(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM notification_delivery WHERE organization_id = ${this.organizationId}::uuid AND id = ${id}::uuid AND channel = 'digest' FOR UPDATE`);
    return this.tx.notificationDelivery.findFirst({ where: { organizationId: this.organizationId, id, channel: "digest" } });
  }
}
