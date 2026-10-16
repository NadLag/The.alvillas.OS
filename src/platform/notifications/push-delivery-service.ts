import type { OutboxEvent } from "@prisma/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import type { NotificationChannel } from "@/platform/providers";
import { WebPushNotificationChannel, pushConfiguration } from "@/platform/providers/web-push";
import { decryptSecret } from "@/platform/auth/secret-encryption";
import { OutboxRetryError } from "@/platform/events/outbox-dispatcher";
import { DeliveryRepository } from "./delivery-repository";
import { deliveryAudit } from "./delivery-service";
import { NotificationRepository } from "./notification-repository";
import { PushRepository } from "./push-repository";
import { channelPayloadSchema, resolveNotificationChannel } from "./notification-channel-service";
import { pushFailure, pushSubscriptionSchema } from "./web-push";

export async function deliverPushChannel(event: OutboxEvent, deps: {
  db?: TenantTransactionRunner; channel?: NotificationChannel; now?: Date; env?: Record<string, string | undefined>;
} = {}) {
  const db = deps.db ?? prisma; const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const ids = await withTenant(db, event.organizationId, async (tx) => {
    const notifications = new NotificationRepository(tx, event.organizationId);
    const stored = await notifications.channelEvent(event.id);
    if (!stored || stored.status === "DISPATCHED") return null;
    const payload = channelPayloadSchema.parse(stored.payload);
    if (payload.channel !== "push") throw new Error("Invalid push channel event");
    const repository = new PushRepository(tx, event.organizationId);
    const existing = await repository.deliveries(stored.id);
    if (existing.length) return existing.map((row) => row.id);
    const subscriptions = await repository.activeSubscriptions(payload.recipientId, now);
    const rows = await Promise.all((subscriptions.length ? subscriptions.map((row) => row.id) : [null]).map((id) => repository.ensureDelivery(stored.id, payload.recipientId, payload.kind, id)));
    return rows.map((row) => row.id);
  });
  if (!ids) return;
  // Each device commits independently. A later failure cannot roll back another
  // browser's acknowledgement or cause successful subscriptions to be resent.
  for (const id of ids) await withTenant(db, event.organizationId, async (tx) => {
    const repository = new PushRepository(tx, event.organizationId);
    const row = await repository.lockedDelivery(id);
    if (!row || row.status !== "PENDING" || (row.nextAttemptAt && row.nextAttemptAt > now)) return;
    const notifications = new NotificationRepository(tx, event.organizationId);
    const stored = await notifications.channelEvent(event.id);
    if (!stored) return;
    const payload = channelPayloadSchema.parse(stored.payload);
    const context = await resolveNotificationChannel(notifications, payload);
    const subscription = row.subscriptionId ? await repository.subscription(row.subscriptionId) : null;
    const policy = await repository.policy(context.target?.propertyId ?? null, now);
    if (!context.allowed || !subscription || subscription.revokedAt || subscription.userAccountId !== payload.recipientId
      || subscription.session.revokedAt || subscription.session.expiresAt <= now
      || subscription.session.sessionVersion !== subscription.userAccount.sessionVersion
      || (subscription.expiresAt && subscription.expiresAt <= now) || !policy) {
      await repository.updateDelivery(id, { status: "SUPPRESSED", errorCode: "access_or_consent_revoked", nextAttemptAt: null }); return;
    }
    const diagnostics = new DeliveryRepository(tx, event.organizationId);
    const config = pushConfiguration(env);
    const attempts = row.attemptCount + 1;
    try {
      if (!config) throw new Error("Missing push configuration");
      if (subscription.vapidPublicKey !== config.publicKey) {
        await repository.revoke(row.userAccountId!, subscription.id, "vapid_key_rotated");
        await repository.updateDelivery(id, { status: "SUPPRESSED", errorCode: "vapid_key_rotated", nextAttemptAt: null }); return;
      }
      const channel = deps.channel ?? new WebPushNotificationChannel(env);
      const result = await channel.notify({ userId: payload.recipientId, subject: context.labels.kinds[context.input.kind], body: context.labels.open,
        locale: context.locale, idempotencyKey: `push:${event.organizationId}:${id}`,
        push: { subscription: pushSubscriptionSchema.parse(JSON.parse(decryptSecret(subscription.encrypted))), deliveryId: id, ttlSeconds: policy.ttlSeconds } });
      if (!result.id) throw new Error("Missing push acknowledgement");
      await repository.updateDelivery(id, { status: "ACCEPTED", acceptedAt: now, attemptCount: attempts, nextAttemptAt: null, errorCode: null, providerStatus: result.statusCode ?? null });
      await diagnostics.log(id, `attempt:${attempts}`, { outcome: "ACCEPTED", attempt: attempts, providerStatus: result.statusCode ?? null, occurredAt: now });
      await deliveryAudit(tx, event.organizationId, id, "accepted", { attempt: attempts, providerStatus: result.statusCode ?? null });
    } catch (error) {
      const failure = pushFailure(error, now);
      if (failure.invalid) await repository.revoke(row.userAccountId!, subscription.id, "subscription_expired");
      const retry = failure.retryable && attempts < policy.maxAttempts;
      const delay = Math.max(Math.min(policy.maxBackoffSeconds, policy.backoffSeconds * 2 ** (attempts - 1)) * 1000, failure.retryAfterMs);
      await repository.updateDelivery(id, { status: retry ? "PENDING" : "FAILED", attemptCount: attempts,
        nextAttemptAt: retry ? new Date(now.getTime() + delay) : null, providerStatus: failure.status,
        errorCode: config ? failure.code : "provider_not_configured" });
      await diagnostics.log(id, `attempt:${attempts}`, { outcome: retry ? "RETRY" : "FAILED", attempt: attempts, providerStatus: failure.status, code: config ? failure.code : "provider_not_configured", occurredAt: now });
      await deliveryAudit(tx, event.organizationId, id, retry ? "retry" : "failed", { attempt: attempts, providerStatus: failure.status });
    }
  });
  const rows = await withTenant(db, event.organizationId, (tx) => new PushRepository(tx, event.organizationId).deliveries(event.id));
  const pending = rows.filter((row) => row.status === "PENDING");
  if (pending.length) throw new OutboxRetryError("push_delivery_retry", pending.reduce<Date>((earliest, row) => row.nextAttemptAt && row.nextAttemptAt < earliest ? row.nextAttemptAt : earliest, new Date(now.getTime() + 86400000)));
  if (rows.some((row) => row.status === "FAILED")) throw new OutboxRetryError("push_delivery_failed", null, true);
  await withTenant(db, event.organizationId, (tx) => new NotificationRepository(tx, event.organizationId).finish(event.id));
}
