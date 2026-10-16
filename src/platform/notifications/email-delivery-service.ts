import type { OutboxEvent } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { renderIdentityEmail } from "@/platform/email/identity-templates";
import { escapeHtml } from "@/platform/encoding/html";
import type { EmailProvider } from "@/platform/providers";
import { ResendEmailProvider } from "@/platform/providers/real";
import { OutboxRetryError } from "@/platform/events/outbox-dispatcher";
import { DeliveryRepository } from "./delivery-repository";
import { NotificationRepository } from "./notification-repository";
import { channelPayloadSchema, resolveNotificationChannel } from "./notification-channel-service";
import { emailFailure, recipientKey, emailIdempotencyKey } from "./email-delivery";
import { deliveryAudit } from "./delivery-service";

export async function deliverEmail(event: OutboxEvent, deps: { db?: TenantTransactionRunner; now?: Date; env?: Record<string, string | undefined>; provider?: EmailProvider } = {}) {
  const db = deps.db ?? prisma; const env = deps.env ?? process.env; const now = deps.now ?? new Date();
  const id = await withTenant(db, event.organizationId, async (tx) => {
    const repository = new DeliveryRepository(tx, event.organizationId); const stored = await repository.event(event.id);
    if (!stored || stored.status === "DISPATCHED") return null;
    const payload = stored.payload as Record<string, unknown>;
    const accountId = payload.recipientId ?? payload.userAccountId;
    if (accountId !== undefined && !z.uuid().safeParse(accountId).success) throw new Error("email_recipient_invalid");
    if (!["notification.channel.requested", "identity.invitation.delivery_requested", "identity.recovery.delivery_requested"].includes(stored.type) || payload.channel !== "email") throw new Error("email_event_invalid");
    return (await repository.ensure(event.id, accountId as string | undefined ?? null, typeof payload.kind === "string" ? payload.kind : stored.type)).id;
  });
  if (!id) return;
  for (const prepare of [true, false]) await withTenant(db, event.organizationId, async (tx) => {
    const repository = new DeliveryRepository(tx, event.organizationId); const row = await repository.lock(id);
    if (!row || row.status !== "PENDING" || (row.nextAttemptAt && row.nextAttemptAt > now)) return;
    const stored = await repository.event(event.id); if (!stored) return;
    const policy = await repository.policy(now);
    async function stop(status: "FAILED" | "SUPPRESSED", code: string) {
      await repository.update(id!, { status, errorCode: code, nextAttemptAt: null });
      await repository.log(id!, `stop:${code}`, { outcome: status, code, occurredAt: now });
      await deliveryAudit(tx, event.organizationId, id!, status.toLowerCase(), { errorCode: code });
    }
    if (!policy) { await stop("SUPPRESSED", "preferences_or_access_changed"); return; }
    if (row.attemptCount >= policy.maxAttempts) { await stop("FAILED", "retry_exhausted"); return; }
    if (row.preparedAt && now.getTime() >= row.preparedAt.getTime() + policy.retryWindowHours * 3600000) { await stop("FAILED", "idempotency_window_expired"); return; }
    if (!row.preparedAt && stored.attemptCount > 0 && now.getTime() >= stored.occurredAt.getTime() + policy.retryWindowHours * 3600000) { await stop("FAILED", "idempotency_window_expired"); return; }
    const notifications = new NotificationRepository(tx, event.organizationId);
    let email: Parameters<EmailProvider["send"]>[0];
    if (stored.type === "notification.channel.requested") {
      const payload = channelPayloadSchema.parse(stored.payload); const context = await resolveNotificationChannel(notifications, payload);
      if (!context.allowed || !context.candidate?.email || !context.destination) { await stop("SUPPRESSED", "preferences_or_access_changed"); return; }
      const origin = new URL(env.APP_URL ?? "http://localhost:3000");
      if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) { await stop("FAILED", "provider_not_configured"); return; }
      const text = `${context.labels.open}: ${new URL(context.destination, origin).href}`;
      email = { to: context.candidate.email, locale: context.locale, subject: context.labels.kinds[context.input.kind], html: `<p>${escapeHtml(text)}</p>`, text, template: "notification.system" };
    } else {
      const payload = stored.payload as Record<string, unknown>;
      if (stored.type === "identity.invitation.delivery_requested") {
        const reference = z.object({ invitationId: z.uuid(), personId: z.uuid() }).parse(payload);
        const invitation = await repository.invitation(reference.invitationId, reference.personId);
        if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now || invitation.person.archivedAt || invitation.email !== payload.toEmail) { await stop("SUPPRESSED", "recipient_unavailable"); return; }
      } else {
        const account = row.userAccountId ? await repository.account(row.userAccountId) : null;
        if (!account || account.status !== "ACTIVE" || account.person.archivedAt || account.email !== payload.toEmail) { await stop("SUPPRESSED", "recipient_unavailable"); return; }
      }
      try { email = renderIdentityEmail(stored.type, payload, env.APP_URL ?? "http://localhost:3000", now); }
      catch { await stop("SUPPRESSED", "recipient_unavailable"); return; }
    }
    const key = recipientKey(event.organizationId, email.to);
    // Share the suppression lock with webhook processing. An accepted hard
    // bounce cannot race another queued email to the same tenant/address.
    await repository.lockRecipient(key);
    if (await repository.suppressed(key)) { await stop("SUPPRESSED", "recipient_suppressed"); return; }
    const request = JSON.stringify({ email, sender: env.EMAIL_FROM ?? null });
    if (row.payloadEncrypted && decryptSecret(row.payloadEncrypted) !== request) { await stop("SUPPRESSED", "content_or_recipient_changed"); return; }
    if (prepare) {
      if (!row.payloadEncrypted) await repository.update(id, { payloadEncrypted: encryptSecret(request), recipientKey: key, preparedAt: now });
      return;
    }
    if (!row.payloadEncrypted) throw new Error("email_request_not_prepared");
    const attempt = row.attemptCount + 1;
    let acknowledgedId: string | null = null; let failure: ReturnType<typeof emailFailure> | null = null;
    try {
      const result = await (deps.provider ?? new ResendEmailProvider(env)).send({ ...email, deliveryReference: { organizationId: event.organizationId, deliveryId: id }, idempotencyKey: emailIdempotencyKey(event) });
      if (!result.id) throw new Error("email_acknowledgement_missing");
      acknowledgedId = result.id;
    } catch (error) {
      failure = emailFailure(error);
      if (!deps.provider && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) failure.code = "provider_not_configured";
    }
    if (failure) {
      const retry = failure.retryable && attempt < policy.maxAttempts;
      const delay = Math.max(Math.min(policy.maxBackoffSeconds, policy.backoffSeconds * 2 ** (attempt - 1)) * 1000, failure.retryAfterMs);
      const next = new Date(now.getTime() + delay);
      const canRetry = retry && next.getTime() < row.preparedAt!.getTime() + policy.retryWindowHours * 3600000;
      await repository.update(id, { status: canRetry ? "PENDING" : "FAILED", attemptCount: attempt, providerStatus: failure.status, errorCode: failure.code, nextAttemptAt: canRetry ? next : null });
      await repository.log(id, `attempt:${attempt}`, { outcome: canRetry ? "RETRY" : "FAILED", attempt, providerStatus: failure.status, code: failure.code, occurredAt: now });
      await deliveryAudit(tx, event.organizationId, id, canRetry ? "retry" : "failed", { attempt, providerStatus: failure.status, errorCode: failure.code });
    } else {
      // Database/audit failures propagate; they must never be mislabeled as a
      // provider rejection after an acknowledged send.
      await repository.update(id, { status: "ACCEPTED", attemptCount: attempt, acceptedAt: now, providerId: acknowledgedId, providerStatus: 200, errorCode: null, nextAttemptAt: null });
      await repository.log(id, `attempt:${attempt}`, { outcome: "ACCEPTED", attempt, providerStatus: 200, occurredAt: now });
      await deliveryAudit(tx, event.organizationId, id, "accepted", { attempt, providerStatus: 200 });
    }
  });
  const row = await withTenant(db, event.organizationId, tx => new DeliveryRepository(tx, event.organizationId).lock(id));
  if (row?.status === "PENDING") throw new OutboxRetryError("email_delivery_retry", row.nextAttemptAt);
  if (row?.status === "FAILED") throw new OutboxRetryError("email_delivery_failed", null, true);
}
