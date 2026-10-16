import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { emailPolicyKey, emailPolicySchema, initialEmailPolicy, type deliveryPageSchema } from "./delivery";
import type { z } from "zod";

export class DeliveryRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async policy(now: Date) {
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + emailPolicyKey}, 0))::text`);
    if (!(await config.list({ key: emailPolicyKey, scopeType: "organization", scopeId: null, take: 1 })).length)
      await config.createVersion({ key: emailPolicyKey, scopeType: "organization", value: initialEmailPolicy, effectiveFrom: new Date(0), reason: "Initialize configurable email delivery policy" });
    const row = await config.resolve({ key: emailPolicyKey, asOf: now, scopes: [{ scopeType: "organization", scopeId: null }] });
    return row ? emailPolicySchema.parse(row.parsedValue) : null;
  }
  ensure(eventId: string, accountId: string | null, kind: string) {
    return this.tx.notificationDelivery.upsert({ where: { organizationId_eventId_deliveryKey: { organizationId: this.organizationId, eventId, deliveryKey: "email" } }, update: {},
      create: { organizationId: this.organizationId, userAccountId: accountId, eventId, deliveryKey: "email", channel: "email", kind } });
  }
  async lock(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM notification_delivery WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`);
    return this.tx.notificationDelivery.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  update(id: string, data: Prisma.NotificationDeliveryUpdateManyMutationInput) { return this.tx.notificationDelivery.updateMany({ where: { organizationId: this.organizationId, id }, data }); }
  event(id: string) { return this.tx.outboxEvent.findFirst({ where: { organizationId: this.organizationId, id } }); }
  account(id: string) { return this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id }, select: { id: true, status: true, email: true, person: { select: { archivedAt: true } } } }); }
  invitation(id: string, personId: string) { return this.tx.invitation.findFirst({ where: { organizationId: this.organizationId, id, personId }, include: { person: true } }); }
  suppressed(key: string) { return this.tx.notificationEmailSuppression.findUnique({ where: { organizationId_recipientKey: { organizationId: this.organizationId, recipientKey: key } } }); }
  suppressions(keys: string[]) { return this.tx.notificationEmailSuppression.findMany({ where: { organizationId: this.organizationId, recipientKey: { in: keys } }, select: { recipientKey: true } }); }
  async lockRecipient(key: string) { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + key}, 0))::text`); }
  suppress(key: string, code: string, deliveryId: string) {
    return this.tx.notificationEmailSuppression.createMany({ data: [{ organizationId: this.organizationId, recipientKey: key, code, deliveryId }], skipDuplicates: true });
  }
  log(deliveryId: string, key: string, data: { outcome: string; attempt?: number; providerStatus?: number | null; code?: string | null; occurredAt: Date }) {
    return this.tx.notificationDeliveryLog.createMany({ data: [{ organizationId: this.organizationId, deliveryId, key, ...data }], skipDuplicates: true });
  }
  receiptKey(key: string) { return this.tx.notificationDeliveryLog.findFirst({ where: { organizationId: this.organizationId, key } }); }
  page(input: z.infer<typeof deliveryPageSchema>) {
    return this.tx.notificationDelivery.findMany({ where: { organizationId: this.organizationId,
      ...(input.channel !== "all" ? { channel: input.channel } : {}), ...(input.status !== "all" ? { status: input.status } : {}),
      ...(input.before ? { OR: [{ createdAt: { lt: new Date(input.before.createdAt) } }, { createdAt: new Date(input.before.createdAt), id: { lt: input.before.id } }] } : {}) },
      select: { id: true, channel: true, kind: true, status: true, attemptCount: true, preparedAt: true, recipientKey: true, nextAttemptAt: true, providerStatus: true, errorCode: true,
        acceptedAt: true, deliveredAt: true, displayedAt: true, openedAt: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
  }
  logs(deliveryId: string, before?: { createdAt: string; id: string }) {
    return this.tx.notificationDeliveryLog.findMany({ where: { organizationId: this.organizationId, deliveryId,
      ...(before ? { OR: [{ createdAt: { lt: new Date(before.createdAt) } }, { createdAt: new Date(before.createdAt), id: { lt: before.id } }] } : {}) },
      select: { id: true, outcome: true, attempt: true, providerStatus: true, code: true, occurredAt: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
  }
  async retry(eventId: string, now: Date) {
    return this.tx.outboxEvent.updateMany({ where: { organizationId: this.organizationId, id: eventId, status: { not: "DISPATCHED" } }, data: { status: "PENDING", nextAttemptAt: now } });
  }
}
