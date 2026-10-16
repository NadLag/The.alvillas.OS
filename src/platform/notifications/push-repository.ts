import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { initialPushPolicy, pushPolicyKey, pushPolicySchema, type BrowserPushSubscription } from "./web-push";

export class PushRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async save(accountId: string, sessionId: string, subscription: BrowserPushSubscription, vapidPublicKey: string) {
    const endpointHash = createHash("sha256").update(subscription.endpoint).digest("hex");
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + endpointHash}, 0))::text`);
    const existing = await this.tx.pushSubscription.findUnique({ where: { organizationId_endpointHash: { organizationId: this.organizationId, endpointHash } } });
    if (existing && existing.userAccountId !== accountId) throw new Error("Subscription belongs to another account");
    if (existing && !existing.revokedAt && existing.vapidPublicKey !== vapidPublicKey) throw new Error("Browser subscription must be renewed after signing key rotation");
    const session = await this.tx.authSession.findFirst({ where: { organizationId: this.organizationId, userAccountId: accountId, id: sessionId, revokedAt: null,
      expiresAt: { gt: new Date() }, userAccount: { status: "ACTIVE", person: { archivedAt: null } } } });
    if (!session) throw new Error("Active session required");
    const unchanged = existing && !existing.revokedAt && existing.sessionId === sessionId && existing.vapidPublicKey === vapidPublicKey
      && decryptSecret(existing.encrypted) === JSON.stringify(subscription);
    if (unchanged) return { id: existing.id, changed: false };
    const data = { sessionId, encrypted: encryptSecret(JSON.stringify(subscription)), vapidPublicKey,
      expiresAt: subscription.expirationTime ? new Date(subscription.expirationTime) : null, revokedAt: null, revokedReason: null };
    const saved = await this.tx.pushSubscription.upsert({ where: { organizationId_endpointHash: { organizationId: this.organizationId, endpointHash } }, update: data,
      create: { organizationId: this.organizationId, userAccountId: accountId, endpointHash, ...data } });
    return { id: saved.id, changed: true };
  }
  subscriptions(accountId: string) {
    return this.tx.pushSubscription.findMany({ where: { organizationId: this.organizationId, userAccountId: accountId, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], session: { revokedAt: null, expiresAt: { gt: new Date() } } },
      select: { id: true, sessionId: true, expiresAt: true, createdAt: true, vapidPublicKey: true }, orderBy: { createdAt: "desc" }, take: 50 });
  }
  activeSubscriptions(accountId: string, now: Date) {
    return this.tx.pushSubscription.findMany({ where: { organizationId: this.organizationId, userAccountId: accountId, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], session: { revokedAt: null, expiresAt: { gt: now } } }, select: { id: true } });
  }
  revoke(accountId: string, id: string | null, reason: string, sessionId?: string) {
    return this.tx.pushSubscription.updateMany({ where: { organizationId: this.organizationId, userAccountId: accountId, revokedAt: null,
      ...(id ? { id } : {}), ...(sessionId ? { sessionId } : {}) }, data: { revokedAt: new Date(), revokedReason: reason } });
  }
  subscription(id: string) { return this.tx.pushSubscription.findFirst({ where: { organizationId: this.organizationId, id }, include: { session: true, userAccount: true } }); }
  async ensureDelivery(eventId: string, accountId: string, kind: string, subscriptionId: string | null) {
    const deliveryKey = subscriptionId ?? "no_subscription";
    return this.tx.notificationDelivery.upsert({ where: { organizationId_eventId_deliveryKey: { organizationId: this.organizationId, eventId, deliveryKey } }, update: {},
      create: { organizationId: this.organizationId, userAccountId: accountId, eventId, kind, subscriptionId, deliveryKey,
        ...(subscriptionId ? {} : { status: "NO_SUBSCRIPTION", errorCode: "no_subscription" }) } });
  }
  async lockedDelivery(id: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM notification_delivery WHERE organization_id = ${this.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`);
    return this.delivery(id);
  }
  delivery(id: string, accountId?: string) { return this.tx.notificationDelivery.findFirst({ where: { organizationId: this.organizationId, id, ...(accountId ? { userAccountId: accountId } : {}) } }); }
  deliveries(eventId: string) { return this.tx.notificationDelivery.findMany({ where: { organizationId: this.organizationId, eventId }, orderBy: { id: "asc" } }); }
  updateDelivery(id: string, data: Prisma.NotificationDeliveryUpdateManyMutationInput) {
    return this.tx.notificationDelivery.updateMany({ where: { organizationId: this.organizationId, id }, data });
  }
  history(accountId: string, before?: { createdAt: Date; id: string }) {
    return this.tx.notificationDelivery.findMany({ where: { organizationId: this.organizationId, userAccountId: accountId, channel: "push",
      ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}) },
      select: { id: true, kind: true, status: true, attemptCount: true, nextAttemptAt: true, providerStatus: true, errorCode: true, acceptedAt: true, displayedAt: true, openedAt: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
  }
  async policy(propertyId: string | null, now: Date) {
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + pushPolicyKey}, 0))::text`);
    if (!(await config.list({ key: pushPolicyKey, scopeType: "organization", scopeId: null, take: 1 })).length) {
      await config.createVersion({ key: pushPolicyKey, scopeType: "organization", value: initialPushPolicy, effectiveFrom: new Date(0), reason: "Initialize configurable push delivery policy" });
    }
    const resolved = await config.resolve({ key: pushPolicyKey, asOf: now, scopes: [...(propertyId ? [{ scopeType: "property", scopeId: propertyId }] : []), { scopeType: "organization", scopeId: null }] });
    return resolved ? pushPolicySchema.parse(resolved.parsedValue) : null;
  }
}
