import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner, type TenantTransaction } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { NotificationAccessError, type NotificationActor } from "./notification-service";
import { DeliveryRepository } from "./delivery-repository";
import { DigestRepository } from "./digest-repository";
import { deliveryPageSchema, deliveryRetrySchema, retryAllowed, safeDeliveryCode } from "./delivery";
import type { DigestReceipt } from "@/platform/email/digest-receipt";
import { decryptSecret } from "@/platform/auth/secret-encryption";
import { recipientKey } from "./email-delivery";
import { notificationInputSchema } from "./notification";

type Deps = { db?: TenantTransactionRunner; now?: Date; requestId?: string };
export function canManageDeliveries(actor: NotificationActor, action: "view" | "edit" = "view") {
  return actor.accountId === actor.authContext.userAccountId && authorize(actor.authContext, action, { type: "audit_log", organizationId: actor.organizationId })
    && authorize(actor.authContext, "configure", { type: "config_rule", organizationId: actor.organizationId });
}
function assertAccess(actor: NotificationActor, action: "view" | "edit") { if (!canManageDeliveries(actor, action)) throw new NotificationAccessError(); }
export async function deliveryAudit(tx: TenantTransaction, organizationId: string, id: string, action: string, after: Record<string, unknown>, actorId: string | null = null, requestId = crypto.randomUUID()) {
  await writeAuditEvent(tx, { organizationId, actorId, action: `notification.delivery.${action}`, resourceType: "notification_delivery", resourceId: id,
    before: null, after, reason: null, requestId, occurredAt: new Date() });
}
export async function deliveryPage(actor: NotificationActor, input: unknown = {}, deps: Deps = {}) {
  const parsed = deliveryPageSchema.parse(input); assertAccess(actor, "view"); const now = deps.now ?? new Date();
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new DeliveryRepository(tx, actor.organizationId);
    const rows = await repository.page(parsed); const email = await repository.policy(now); const digest = await new DigestRepository(tx, actor.organizationId).policy(now);
    const suppressed = new Set((await repository.suppressions(rows.flatMap(row => row.recipientKey ? [row.recipientKey] : []))).map(row => row.recipientKey));
    const last = rows.slice(0, 20).at(-1);
    return { items: rows.slice(0, 20).map((row) => {
      // Recipient and provider metadata never enter the client payload. Central
      // presentation policy applies even to administrators with broad grants.
      const masked = present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { type: "audit_log", organizationId: actor.organizationId,
        data: { recipient: "private", providerReference: "private" } }, { recipient: { dataClass: "sensitive" }, providerReference: { dataClass: "sensitive" } });
      const policy = row.channel === "digest" ? digest : row.channel === "email" ? email : null;
      const knownKind = notificationInputSchema.options.some(option => option.shape.kind.value === row.kind);
      const type = knownKind ? row.kind : ["digest", "identity.invitation.delivery_requested", "identity.recovery.delivery_requested"].includes(row.kind) ? row.kind.replaceAll(".", "_") : "other";
      return { ...row, kind: type, ...masked, errorCode: safeDeliveryCode(row.errorCode), preparedAt: undefined, recipientKey: undefined,
        createdAt: row.createdAt.toISOString(), nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null, acceptedAt: row.acceptedAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null, displayedAt: row.displayedAt?.toISOString() ?? null, openedAt: row.openedAt?.toISOString() ?? null,
        canRetry: canManageDeliveries(actor, "edit") && row.channel !== "push" && !suppressed.has(row.recipientKey ?? "") && row.attemptCount > 0 && retryAllowed(row, policy, now) };
    }), nextCursor: rows.length > 20 && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
  });
}
export async function deliveryLogs(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  const parsed = z.object({ id: z.uuid(), before: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().optional() }).strict().parse(input); assertAccess(actor, "view");
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new DeliveryRepository(tx, actor.organizationId);
    if (!await repository.lock(parsed.id)) throw new NotificationAccessError();
    const rows = await repository.logs(parsed.id, parsed.before); const last = rows.slice(0, 20).at(-1);
    return { items: rows.slice(0, 20).map(row => ({ ...row, code: safeDeliveryCode(row.code), occurredAt: row.occurredAt.toISOString(), createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length > 20 && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
  });
}
export async function retryDelivery(actor: NotificationActor, input: unknown, deps: Deps = {}) {
  const parsed = deliveryRetrySchema.parse(input); assertAccess(actor, "edit"); const now = deps.now ?? new Date();
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new DeliveryRepository(tx, actor.organizationId); const row = await repository.lock(parsed.id);
    if (!row || !["email", "digest"].includes(row.channel) || !row.attemptCount) throw new NotificationAccessError();
    const policy = row.channel === "digest" ? await new DigestRepository(tx, actor.organizationId).policy(now) : await repository.policy(now);
    if (!retryAllowed(row, policy, now) || (row.recipientKey && await repository.suppressed(row.recipientKey))) throw new NotificationAccessError();
    const event = await repository.event(row.eventId);
    if (!event || event.status === "DISPATCHED") throw new NotificationAccessError();
    // A unique queue marker makes repeated form submissions harmless. The
    // provider is contacted only by the existing signed Inngest dispatcher.
    const marker = `manual:${row.attemptCount}`;
    if (await repository.receiptKey(`${row.id}:${marker}`)) return { queued: true };
    await repository.retry(row.eventId, now);
    await repository.log(row.id, `${row.id}:${marker}`, { outcome: "RETRY_QUEUED", attempt: row.attemptCount, occurredAt: now });
    // Free-form operator text can include personal data: record its presence,
    // never echo it into diagnostics, logs or audit snapshots.
    await deliveryAudit(tx, actor.organizationId, row.id, "retry_requested", { attempt: row.attemptCount, reasonProvided: Boolean(parsed.reason) }, actor.accountId, deps.requestId);
    return { queued: true };
  });
}
export async function recordDeliveryReceipt(receipt: DigestReceipt, deps: Deps = {}) {
  const { organization_id: organizationId, delivery_id: id } = receipt.data.tags;
  return withTenant(deps.db ?? prisma, organizationId, async (tx) => {
    const repository = new DeliveryRepository(tx, organizationId); const row = await repository.lock(id);
    if (!row || !["email", "digest"].includes(row.channel)) return false;
    if (!row.providerId) return row.status !== "PENDING";
    if (row.providerId !== receipt.data.email_id) return true;
    const key = `webhook:${receipt.eventId ?? `${receipt.type}:${receipt.created_at}`}`;
    if (await repository.receiptKey(key)) return true;
    const at = new Date(receipt.created_at); const hard = receipt.type === "email.bounced" && receipt.data.bounce?.type !== "Transient";
    const code = receipt.type === "email.bounced" ? hard ? "hard_bounce" : "soft_bounce" : receipt.type === "email.complained" ? "complaint"
      : receipt.type === "email.failed" ? "provider_delivery_failed" : receipt.type === "email.suppressed" ? "recipient_suppressed" : receipt.type === "email.delivery_delayed" ? "delivery_delayed" : null;
    await repository.log(id, key, { outcome: receipt.type, code, occurredAt: at });
    // A late bounce/complaint must win over an earlier delivered receipt. Positive
    // or delayed receipts never resurrect failed or suppressed deliveries.
    const terminal = ["BOUNCED", "COMPLAINED", "FAILED", "SUPPRESSED"].includes(row.status);
    if (receipt.type === "email.complained" || (receipt.type === "email.bounced" && row.status !== "COMPLAINED"))
      await repository.update(id, { status: receipt.type === "email.complained" ? "COMPLAINED" : "BOUNCED", errorCode: code, nextAttemptAt: null });
    else if (!terminal && ["email.failed", "email.suppressed"].includes(receipt.type)) await repository.update(id, { status: "FAILED", errorCode: code, nextAttemptAt: null });
    else if (!terminal && receipt.type === "email.delivered" && !row.deliveredAt) await repository.update(id, { status: "DELIVERED", deliveredAt: at, errorCode: null, nextAttemptAt: null });
    else if (!terminal && receipt.type === "email.delivery_delayed" && row.status !== "DELIVERED") await repository.update(id, { errorCode: code });
    let addressKey = row.recipientKey;
    if (!addressKey && row.payloadEncrypted) {
      const request = z.object({ email: z.object({ to: z.email() }) }).parse(JSON.parse(decryptSecret(row.payloadEncrypted)) as unknown);
      addressKey = recipientKey(organizationId, request.email.to);
      await repository.update(id, { recipientKey: addressKey });
    }
    if (addressKey) await repository.lockRecipient(addressKey);
    if (addressKey && (hard || receipt.type === "email.complained" || receipt.type === "email.suppressed")) await repository.suppress(addressKey, code!, id);
    await deliveryAudit(tx, organizationId, id, "provider_event", { outcome: receipt.type, code });
    return true;
  });
}
