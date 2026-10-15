import { z } from "zod";

// Only browser-vendor push services may receive subscription credentials.
// Exact hosts/suffixes prevent arbitrary URL fetches and DNS rebinding to LAN hosts.
export function allowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && ((url.hostname === "fcm.googleapis.com" && url.pathname.startsWith("/fcm/send/"))
        || (url.hostname.endsWith(".push.services.mozilla.com") && url.pathname.startsWith("/wpush/"))
        || (url.hostname === "web.push.apple.com" && url.pathname.startsWith("/")));
  } catch { return false; }
}
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(4096).refine(allowedPushEndpoint),
  expirationTime: z.number().int().positive().nullable(),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/u), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/u) }).strict()
}).strict();
export type BrowserPushSubscription = z.infer<typeof pushSubscriptionSchema>;
export const pushPolicyKey = "notification.push.delivery_policy";
export const pushPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(25),
  backoffSeconds: z.number().int().min(1).max(3600),
  maxBackoffSeconds: z.number().int().min(1).max(86400),
  ttlSeconds: z.number().int().min(0).max(2419200)
}).strict();
// Persisted in config_rule at first use; all subsequent delivery uses the resolver.
export const initialPushPolicy = { maxAttempts: 5, backoffSeconds: 60, maxBackoffSeconds: 3600, ttlSeconds: 86400 };
export type PushPolicy = z.infer<typeof pushPolicySchema>;
export function pushFailure(error: unknown, now: Date) {
  const value = error as { statusCode?: unknown; headers?: Record<string, string> } | null;
  const status = typeof value?.statusCode === "number" ? value.statusCode : null;
  const retryAfter = value?.headers?.["retry-after"];
  const delay = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - now.getTime() : 0;
  return { status, invalid: status === 404 || status === 410,
    retryable: status === null || status === 408 || status === 429 || status >= 500,
    retryAfterMs: Number.isFinite(delay) ? Math.max(0, Math.min(delay, 86400000)) : 0,
    code: status === 404 || status === 410 ? "subscription_expired" : status === 401 || status === 403 ? "vapid_rejected" : status === 429 ? "rate_limited" : status === null ? "transport_failed" : "provider_rejected" };
}
