import { z } from "zod";
import type { OutboxEvent } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner, type TenantTransaction } from "@/platform/db/tenant";
import { contextForRoleAssignments } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { securityEnrollment } from "@/platform/auth/security-enrollment";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import type { EmailProvider } from "@/platform/providers";
import { ResendEmailProvider } from "@/platform/providers/real";
import { OutboxRetryError } from "@/platform/events/outbox-dispatcher";
import { digestReceiptSchema } from "@/platform/email/digest-receipt";
import { DeliveryRepository } from "./delivery-repository";
import { emailFailure, recipientKey } from "./email-delivery";
import { recordDeliveryReceipt } from "./delivery-service";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { renderDigestEmail } from "@/platform/email/digest-template";
import { NotificationRepository } from "./notification-repository";
import { notificationDestination, notificationInputSchema } from "./notification";
import { assertInbox, NotificationAccessError, type NotificationActor } from "./notification-service";
import { DigestRepository } from "./digest-repository";
import { digestEventSchema, digestEventType, digestSettingsSchema, nextDigestAt, afterDigestQuietHours, inDigestQuietHours, type DigestSettings } from "./digest";

type Deps = { db?: TenantTransactionRunner; now?: Date; env?: Record<string, string | undefined>; provider?: EmailProvider };
type Row = { id: string; kind: string; targetId: string; recipientId: string; createdAt: Date };
async function authorizedItems(notifications: NotificationRepository, recipientId: string, rows: Row[], language: DigestSettings["language"]) {
  const candidate = await notifications.channelRecipient(recipientId);
  if (!candidate || !candidate.email || securityEnrollment(candidate).setupRequired) return { candidate: null, items: [] };
  const ctx = contextForRoleAssignments(candidate.organizationId, candidate.id, candidate.roleAssignments);
  const targets = await notifications.targets(rows, recipientId);
  const items = rows.filter((row) => {
    const parsed = notificationInputSchema.safeParse({ kind: row.kind, recipientId, targetId: row.targetId });
    return parsed.success && notificationDestination(ctx, parsed.data, targets.get(row.targetId) ?? null, language);
  });
  return { candidate, items };
}
async function audit(tx: TenantTransaction, organizationId: string, accountId: string, id: string, action: string, after: Record<string, unknown>) {
  await writeAuditEvent(tx, { organizationId, actorId: null, action: `notification.digest.${action}`, resourceType: "notification", resourceId: id,
    before: null, after: { recipientId: accountId, ...after }, reason: null, requestId: crypto.randomUUID(), occurredAt: new Date() });
}
export async function digestSettings(actor: NotificationActor, input: unknown = {}, deps: Deps = {}) {
  assertInbox(actor, "view");
  const cursor = z.object({ before: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().optional() }).strict().parse(input).before;
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const notifications = new NotificationRepository(tx, actor.organizationId); const repository = new DigestRepository(tx, actor.organizationId);
    const candidate = await notifications.channelRecipient(actor.accountId);
    if (!candidate) throw new NotificationAccessError();
    const preferences = await notifications.preferences(actor.accountId); const policy = await repository.policy(deps.now ?? new Date());
    const rows = await repository.history(actor.accountId, cursor ? { ...cursor, createdAt: new Date(cursor.createdAt) } : undefined);
    const last = rows.slice(0, 20).at(-1);
    const data = { settings: preferences.digest ?? { frequency: "off" as const, language: candidate.person.preferredLocale as DigestSettings["language"], timezone: (await repository.timezone())?.timezone ?? "Africa/Casablanca",
      time: policy?.defaultTime ?? "", weekday: policy?.defaultWeekday ?? 0, quietHours: policy?.defaultQuietHours ?? null },
      defaultQuietHours: policy?.defaultQuietHours ?? null, available: Boolean(policy && candidate.email), emailEnabled: Boolean(preferences.email.enabled && preferences.email.operations),
      history: rows.slice(0, 20).map((row) => ({ ...row, scheduledAt: row.scheduledAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        acceptedAt: row.acceptedAt?.toISOString() ?? null, deliveredAt: row.deliveredAt?.toISOString() ?? null })),
      nextCursor: rows.length > 20 && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
    return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { type: "notification", organizationId: actor.organizationId, id: actor.accountId, data }, {}) as typeof data;
  });
}
export async function scheduleDigests(organizationId: string, deps: Deps = {}) {
  const db = deps.db ?? prisma; const now = deps.now ?? new Date();
  const due = await withTenant(db, organizationId, (tx) => new DigestRepository(tx, organizationId).due(now));
  if (due.length) requireCurrentTimezoneData();
  let scheduled = 0;
  for (const { userAccountId } of due) await withTenant(db, organizationId, async (tx) => {
    const notifications = new NotificationRepository(tx, organizationId); const repository = new DigestRepository(tx, organizationId);
    const active = await notifications.activeRecipient(userAccountId, true);
    const preference = await repository.preference(userAccountId);
    if (!preference?.digestNextAt || preference.digestNextAt > now) return;
    const settings = digestSettingsSchema.parse(preference.digestSettings);
    const policy = await repository.policy(now);
    if (settings.frequency === "off" || !preference.emailEnabled || !preference.emailOperations) { await repository.advance(userAccountId, null); return; }
    if (!active || !policy) { await repository.advance(userAccountId, nextDigestAt(settings, now)); return; }
    if (inDigestQuietHours(settings, now)) { await repository.advance(userAccountId, afterDigestQuietHours(settings, now)); return; }
    const selected: Row[] = []; let cursor: { createdAt: Date; id: string } | undefined;
    while (selected.length < policy.maxItems) {
      const rows = await repository.unread(userAccountId, now, cursor);
      const { items } = await authorizedItems(notifications, userAccountId, rows, settings.language);
      selected.push(...items.slice(0, policy.maxItems - selected.length));
      if (rows.length < 200) break;
      cursor = rows.at(-1);
    }
    if (selected.length) {
      const delivery = await repository.enqueue(userAccountId, preference.digestRevision, preference.digestNextAt, selected.map((row) => row.id));
      await audit(tx, organizationId, userAccountId, delivery.id, "scheduled", { count: selected.length, scheduledAt: preference.digestNextAt.toISOString(), language: settings.language });
      scheduled++;
    }
    await repository.advance(userAccountId, nextDigestAt(settings, now));
  });
  return { scheduled };
}

export async function deliverDigest(event: OutboxEvent, deps: Deps = {}) {
  requireCurrentTimezoneData();
  if (event.type !== digestEventType) throw new Error("digest_event_invalid");
  const db = deps.db ?? prisma; const now = deps.now ?? new Date(); const env = deps.env ?? process.env;
  // Persist the exact encrypted request before contacting Resend. A crash between
  // provider acknowledgement and commit can only replay the same bytes and key.
  for (const prepare of [true, false]) await withTenant(db, event.organizationId, async (tx) => {
    const repository = new DigestRepository(tx, event.organizationId); const notifications = new NotificationRepository(tx, event.organizationId);
    const stored = await repository.event(event.id);
    if (!stored || stored.status === "DISPATCHED") return;
    const payload = digestEventSchema.parse(stored.payload);
    const active = await notifications.activeRecipient(payload.recipientId, true);
    const row = await repository.lockedDelivery(stored.id, payload.recipientId);
    if (!row || row.status !== "PENDING" || (row.nextAttemptAt && row.nextAttemptAt > now)) return;
    const preference = await repository.preference(payload.recipientId); const policy = await repository.policy(now);
    async function suppress(code: string) {
      await repository.update(row!.id, { status: "SUPPRESSED", errorCode: code, nextAttemptAt: null });
      await audit(tx, event.organizationId, payload.recipientId, row!.id, "suppressed", { code });
    }
    if (!active || !policy || !preference?.digestSettings || preference.digestRevision !== payload.revision || !preference.emailEnabled || !preference.emailOperations) { await suppress("preferences_or_access_changed"); return; }
    const settings = digestSettingsSchema.parse(preference.digestSettings);
    if (settings.frequency === "off") { await suppress("preferences_or_access_changed"); return; }
    // Resend only retains idempotency keys for 24h. Never replay after our shorter
    // configured retry window, including after downtime or long quiet periods.
    if (row.preparedAt && now.getTime() >= row.preparedAt.getTime() + policy.retryWindowHours * 3600000) {
      await repository.update(row.id, { status: "FAILED", errorCode: "idempotency_window_expired", nextAttemptAt: null }); return;
    }
    if (inDigestQuietHours(settings, now)) { await repository.update(row.id, { nextAttemptAt: afterDigestQuietHours(settings, now) }); return; }
    const { candidate, items } = await authorizedItems(notifications, payload.recipientId, await repository.items(payload.recipientId, row.id), settings.language);
    if (!candidate?.email || !items.length) { await suppress("no_authorized_unread_items"); return; }
    const email = { ...renderDigestEmail({ to: candidate.email, settings, scheduledAt: new Date(payload.scheduledAt), items, appUrl: env.APP_URL ?? "http://localhost:3000" }), deliveryReference: { organizationId: event.organizationId, deliveryId: row.id } };
    const diagnostics = new DeliveryRepository(tx, event.organizationId);
    const key = recipientKey(event.organizationId, email.to);
    await diagnostics.lockRecipient(key);
    if (await diagnostics.suppressed(key)) { await suppress("recipient_suppressed"); return; }
    const serialized = JSON.stringify({ email, sender: env.EMAIL_FROM ?? null });
    if (row.payloadEncrypted && decryptSecret(row.payloadEncrypted) !== serialized) { await suppress("content_or_recipient_changed"); return; }
    if (prepare) {
      if (!row.payloadEncrypted) await repository.update(row.id, { payloadEncrypted: encryptSecret(serialized), preparedAt: now, recipientKey: key });
      return;
    }
    if (!row.payloadEncrypted) throw new Error("digest_request_not_prepared");
    if (row.attemptCount >= policy.maxAttempts) { await repository.update(row.id, { status: "FAILED", errorCode: "retry_exhausted", nextAttemptAt: null }); return; }
    const attempts = row.attemptCount + 1;
    try {
      const provider = deps.provider ?? new ResendEmailProvider(env);
      const result = await provider.send({ ...email, idempotencyKey: `digest:${event.organizationId}:${row.id}` });
      if (!result.id) throw new Error("digest_acknowledgement_missing");
      await repository.update(row.id, { status: "ACCEPTED", attemptCount: attempts, acceptedAt: now, providerId: result.id, providerStatus: 200, errorCode: null, nextAttemptAt: null });
      await diagnostics.log(row.id, `attempt:${attempts}`, { outcome: "ACCEPTED", attempt: attempts, providerStatus: 200, occurredAt: now });
      await audit(tx, event.organizationId, payload.recipientId, row.id, "accepted", { count: items.length, attempts });
    } catch (error) {
      const failure = emailFailure(error); const status = failure.status;
      const delay = Math.max(Math.min(policy.maxBackoffSeconds, policy.backoffSeconds * 2 ** (attempts - 1)) * 1000, failure.retryAfterMs);
      const next = afterDigestQuietHours(settings, new Date(now.getTime() + delay));
      const retry = attempts < policy.maxAttempts && failure.retryable && next.getTime() < row.preparedAt!.getTime() + policy.retryWindowHours * 3600000;
      await repository.update(row.id, { status: retry ? "PENDING" : "FAILED", attemptCount: attempts, providerStatus: status,
        nextAttemptAt: retry ? next : null, errorCode: failure.code });
      await diagnostics.log(row.id, `attempt:${attempts}`, { outcome: retry ? "RETRY" : "FAILED", attempt: attempts, providerStatus: status, code: failure.code, occurredAt: now });
      await audit(tx, event.organizationId, payload.recipientId, row.id, retry ? "retry" : "failed", { attempts, status });
    }
  });
  const result = await withTenant(db, event.organizationId, async (tx) => {
    const repository = new DigestRepository(tx, event.organizationId); const stored = await repository.event(event.id);
    return stored ? repository.lockedDelivery(event.id, digestEventSchema.parse(stored.payload).recipientId) : null;
  });
  if (result?.status === "PENDING") throw new OutboxRetryError("digest_delivery_retry", result.nextAttemptAt);
  if (result?.status === "FAILED") throw new OutboxRetryError("digest_delivery_failed", null, true);
}

export async function recordDigestReceipt(input: unknown, deps: Deps = {}) {
  return recordDeliveryReceipt(digestReceiptSchema.parse(input), deps);
}
