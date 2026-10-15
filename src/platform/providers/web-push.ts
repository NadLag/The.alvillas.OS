import webpush from "web-push";
import { createECDH } from "node:crypto";
import type { NotificationChannel } from "./index";
import { pushSubscriptionSchema } from "@/platform/notifications/web-push";

export function pushConfiguration(env: Record<string, string | undefined> = process.env) {
  try {
    if (!env.VAPID_SUBJECT || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
    const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.from(env.VAPID_PRIVATE_KEY, "base64url"));
    if (key.getPublicKey().toString("base64url") !== env.VAPID_PUBLIC_KEY) return null;
    // Validate signing material without logging provider errors or mutating global SDK state.
    webpush.getVapidHeaders("https://fcm.googleapis.com", env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, "aes128gcm");
    return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } catch { return null; }
}
export function validatePushRegistration(subscription: ReturnType<typeof pushSubscriptionSchema.parse>, config: NonNullable<ReturnType<typeof pushConfiguration>>) {
  // Validate the browser's EC point and auth material with the same mature SDK
  // used for delivery; this only builds a request and performs no network I/O.
  webpush.generateRequestDetails(subscription, "subscription-validation", { vapidDetails: config, TTL: 0 });
}
export class WebPushNotificationChannel implements NotificationChannel {
  constructor(private readonly env: Record<string, string | undefined> = process.env,
    private readonly send: typeof webpush.sendNotification = webpush.sendNotification) {}
  async notify(input: Parameters<NotificationChannel["notify"]>[0]) {
    const config = pushConfiguration(this.env);
    if (!config || !input.push) throw new Error("Web push is not configured");
    const subscription = pushSubscriptionSchema.parse(input.push.subscription);
    const result = await this.send(subscription, JSON.stringify({ deliveryId: input.push.deliveryId }), {
      vapidDetails: config, TTL: input.push.ttlSeconds, timeout: 5000, contentEncoding: "aes128gcm",
      // Stable per-device topic replaces uncertain retries at the browser service.
      topic: input.push.deliveryId.replaceAll("-", ""), urgency: "normal"
    });
    if (result.statusCode < 200 || result.statusCode >= 300) throw Object.assign(new Error("Push service rejected delivery"), { statusCode: result.statusCode });
    return { id: input.push.deliveryId, statusCode: result.statusCode };
  }
}
