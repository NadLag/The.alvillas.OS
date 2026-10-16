import { z } from "zod";

export const emailPolicyKey = "notification.email.delivery_policy";
export const emailPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(25), backoffSeconds: z.number().int().min(1).max(3600),
  maxBackoffSeconds: z.number().int().min(1).max(21600), retryWindowHours: z.number().int().min(1).max(23)
}).strict();
export const initialEmailPolicy: z.infer<typeof emailPolicySchema> = { maxAttempts: 5, backoffSeconds: 60, maxBackoffSeconds: 3600, retryWindowHours: 23 };
export type DeliveryPolicy = z.infer<typeof emailPolicySchema>;
export const deliveryPageSchema = z.object({
  channel: z.enum(["all", "email", "digest", "push"]).default("all"),
  status: z.enum(["all", "PENDING", "ACCEPTED", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED", "SUPPRESSED", "NO_SUBSCRIPTION"]).default("all"),
  before: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().optional()
}).strict();
export const deliveryRetrySchema = z.object({ id: z.uuid(), reason: z.string().trim().min(5).max(500) }).strict();
export function retryAllowed(row: { status: string; attemptCount: number; preparedAt: Date | null; nextAttemptAt: Date | null }, policy: DeliveryPolicy | null, now: Date) {
  return Boolean(policy && row.status === "PENDING" && row.attemptCount < policy.maxAttempts && row.preparedAt
    && now.getTime() < row.preparedAt.getTime() + policy.retryWindowHours * 3600000
    && (!row.nextAttemptAt || row.nextAttemptAt <= now));
}
export const safeDeliveryCodes = ["rate_limited", "idempotency_conflict", "provider_authentication", "provider_rejected", "provider_unavailable", "provider_not_configured",
  "idempotency_window_expired", "retry_exhausted", "preferences_or_access_changed", "content_or_recipient_changed", "no_authorized_unread_items", "recipient_suppressed",
  "recipient_unavailable", "provider_delivery_failed", "hard_bounce", "soft_bounce", "complaint", "delivery_delayed", "access_or_consent_revoked", "subscription_expired", "vapid_key_rotated", "vapid_rejected", "transport_failed"] as const;
export function safeDeliveryCode(value: string | null) { return value && (safeDeliveryCodes as readonly string[]).includes(value) ? value : value ? "provider_rejected" : null; }
