import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { allowedPushEndpoint, pushFailure, pushPolicySchema, pushSubscriptionSchema } from "@/platform/notifications/web-push";
import { WebPushNotificationChannel, pushConfiguration } from "@/platform/providers/web-push";

describe("VAPID web push", () => {
  it("encrypts a real RFC8291 request and signs a verifiable origin-bound VAPID JWT", async () => {
    const pair = webpush.generateVAPIDKeys(); const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test-only", expirationTime: null,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") } };
    const env = { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey, VAPID_SUBJECT: "mailto:notifications@example.test" };
    const send = vi.fn<typeof webpush.sendNotification>((sub, payload, options) => {
      const request = webpush.generateRequestDetails(sub, payload ?? undefined, options);
      expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(request.body).toBeInstanceOf(Buffer); expect(request.body?.toString()).not.toContain("deliveryId");
      const authorization = String(request.headers.Authorization);
      const jwt = authorization.match(/t=([^,]+)/u)![1]; const [head, body, signature] = jwt.split(".");
      const publicBytes = Buffer.from(pair.publicKey, "base64url");
      const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: publicBytes.subarray(1, 33).toString("base64url"), y: publicBytes.subarray(33).toString("base64url") } });
      expect(verify("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
      expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: env.VAPID_SUBJECT });
      return Promise.resolve({ statusCode: 201, headers: {}, body: "" });
    });
    const channel = new WebPushNotificationChannel(env, send);
    const deliveryId = crypto.randomUUID();
    await expect(channel.notify({ userId: "account", subject: "unused", body: "unused", push: { subscription, deliveryId, ttlSeconds: 600 } })).resolves.toEqual({ id: deliveryId, statusCode: 201 });
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][2]?.topic).toBe(deliveryId.replaceAll("-", ""));
    expect(pushConfiguration({ ...env, VAPID_PRIVATE_KEY: "invalid" })).toBeNull();
    expect(pushConfiguration({ ...env, VAPID_SUBJECT: "" })).toBeNull();
  });
  it("rejects SSRF endpoints, credentials, ports and malformed browser key material", () => {
    for (const endpoint of ["http://127.0.0.1/", "https://localhost/", "https://fcm.googleapis.com.attacker.test/fcm/send/abc", "https://user:pass@fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com:444/fcm/send/abc", "https://web.push.apple.com.attacker.test/abc", "https://fcm.googleapis.com/internal"]) expect(allowedPushEndpoint(endpoint)).toBe(false);
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/token", "https://updates.push.services.mozilla.com/wpush/v2/token", "https://web.push.apple.com/token"]) expect(allowedPushEndpoint(endpoint)).toBe(true);
    expect(pushSubscriptionSchema.safeParse({ endpoint: "https://fcm.googleapis.com/fcm/send/token", expirationTime: null, keys: { p256dh: "invalid", auth: "invalid" } }).success).toBe(false);
    expect(pushPolicySchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
  });
  it("classifies permanent, transient and throttled failures without exposing exception contents", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    for (const statusCode of [404, 410]) expect(pushFailure({ statusCode, body: "secret" }, now)).toMatchObject({ invalid: true, retryable: false });
    expect(pushFailure({ statusCode: 403, body: "secret" }, now)).toMatchObject({ invalid: false, retryable: false, code: "vapid_rejected" });
    expect(pushFailure({ statusCode: 429, headers: { "retry-after": "120" } }, now)).toMatchObject({ retryable: true, retryAfterMs: 120000 });
    expect(pushFailure({ statusCode: 503, headers: { "retry-after": "Thu, 15 Oct 2026 12:05:00 GMT" } }, now).retryAfterMs).toBe(300000);
    expect(pushFailure(new Error("private endpoint and keys"), now).code).toBe("transport_failed");
  });
});
