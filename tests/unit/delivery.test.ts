import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { emailFailure, recipientKey } from "@/platform/notifications/email-delivery";
import { retryAllowed, initialEmailPolicy, safeDeliveryCode, deliveryRetrySchema, emailPolicySchema } from "@/platform/notifications/delivery";
import { EmailRequestError } from "@/platform/providers/real";
import { verifyDigestReceipt } from "@/platform/email/digest-receipt";

describe("delivery diagnostics domain", () => {
  it("retries transient failures and concurrent requests but permanently rejects payload conflicts and credential errors", () => {
    for (const status of [408, 409, 429, 500, 502, 503]) expect(emailFailure(new EmailRequestError(status, 123)).retryable).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) expect(emailFailure(new EmailRequestError(status)).retryable).toBe(false);
    expect(emailFailure(new EmailRequestError(409, 0, "invalid_idempotent_request"))).toMatchObject({ retryable: false, code: "idempotency_conflict" });
    expect(JSON.stringify(emailFailure(new Error("PRIVATE RECIPIENT AND SECRET")))).not.toContain("PRIVATE");
  });
  it("enforces cooldown, attempt budget, terminal states and the strict provider retention window", () => {
    const preparedAt = new Date("2030-01-01T00:00:00Z"); const now = new Date("2030-01-01T01:00:00Z");
    const row = { status: "PENDING", attemptCount: 1, preparedAt, nextAttemptAt: now };
    expect(retryAllowed(row, initialEmailPolicy, now)).toBe(true);
    expect(retryAllowed({ ...row, nextAttemptAt: new Date(now.getTime() + 1) }, initialEmailPolicy, now)).toBe(false);
    expect(retryAllowed({ ...row, attemptCount: 5 }, initialEmailPolicy, now)).toBe(false);
    expect(retryAllowed(row, initialEmailPolicy, new Date("2030-01-01T23:00:00Z"))).toBe(false);
    for (const status of ["FAILED", "BOUNCED", "COMPLAINED", "DELIVERED", "ACCEPTED", "SUPPRESSED"]) expect(retryAllowed({ ...row, status }, initialEmailPolicy, now)).toBe(false);
    expect(emailPolicySchema.safeParse({ ...initialEmailPolicy, retryWindowHours: 24 }).success).toBe(false);
    expect(deliveryRetrySchema.safeParse({ id: crypto.randomUUID(), reason: " " }).success).toBe(false);
  });
  it("normalizes recipient suppression within a tenant and allow-lists diagnostics", () => {
    expect(recipientKey("org", " Recipient@Example.test ")).toBe(recipientKey("org", "recipient@example.test"));
    expect(recipientKey("other", "recipient@example.test")).not.toBe(recipientKey("org", "recipient@example.test"));
    expect(safeDeliveryCode("secret-token@example.test")).toBe("provider_rejected");
  });
  it("validates signed provider events for all application email templates and strips all SMTP and recipient content", () => {
    const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`; const at = new Date();
    for (const template of ["notification_digest", "notification_system", "identity_invitation", "identity_recovery"]) for (const type of ["email.bounced", "email.complained", "email.delivery_delayed", "email.failed", "email.sent", "email.suppressed"]) {
      const body = JSON.stringify({ type, created_at: at.toISOString(), data: { email_id: crypto.randomUUID(), to: ["PRIVATE@example.test"], subject: "SECRET", bounce: { type: "Permanent", message: "PRIVATE SMTP", diagnosticCode: "SECRET" }, tags: { template, organization_id: crypto.randomUUID(), delivery_id: crypto.randomUUID() } } });
      const headers = new Headers({ "svix-id": "msg_verified", "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(secret).sign("msg_verified", at, body) });
      const parsed = verifyDigestReceipt(body, headers, secret);
      expect(parsed).toMatchObject({ eventId: "msg_verified", type, data: { bounce: { type: "Permanent" } } });
      expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|SECRET/u);
    }
  });
});
