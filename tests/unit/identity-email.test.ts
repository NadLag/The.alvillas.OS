import { describe, expect, it, vi } from "vitest";
import { renderIdentityEmail, EmailDeliveryValidationError } from "@/platform/email/identity-templates";
import { createInngestOutboxHandlers, type InngestTransport } from "@/platform/events/inngest";
import { ResendEmailProvider, type HttpTransport } from "@/platform/providers/real";
import { emailIdempotencyKey } from "@/platform/notifications/email-delivery";

const origin = "https://app.example.test";
const code = "invitation_code_12345678";
const now = new Date("2026-10-14T00:00:00Z");
const expiresAt = "2099-10-15T00:00:00Z";
const invitation = (locale = "en") => ({ channel: "email", toEmail: "person@example.test", locale, activationCode: code, activationUrl: `${origin}/${locale}/activate/${code}`, expiresAt });
const event = {
  id: "018f0a0b-0000-7000-9000-000000000011", organizationId: "018f0a0b-0000-7000-9000-000000000001",
  type: "identity.invitation.delivery_requested", payload: invitation(), idempotencyKey: "invite:one",
  status: "PENDING" as const, occurredAt: now, createdAt: now, updatedAt: now, processedAt: null, nextAttemptAt: null, lastError: null, attemptCount: 0
};
const response = () => ({ ok: true, status: 200, json: () => Promise.resolve({ id: "email-id" }), text: () => Promise.resolve(""), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });

describe("localized identity email delivery", () => {
  it.each(["en", "fr", "ar"])("renders invitation and recovery with %s locale and direction", (locale) => {
    const email = renderIdentityEmail(event.type, invitation(locale), origin, now);
    expect(email.html).toContain(`lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"`);
    expect(email.text).toContain(`${origin}/${locale}/activate/${code}`);
    expect(email.text).toContain(code);
    expect(email.subject).not.toEqual("");
    const recovery = renderIdentityEmail("identity.recovery.delivery_requested", { ...invitation(locale), recoveryCode: "abc12345-12345abc", recoveryUrl: `${origin}/${locale}/recover` }, origin, now);
    expect(recovery.template).toBe("identity.recovery");
    expect(recovery.text).toContain("abc12345-12345abc");
    expect(recovery.text).toContain(`${origin}/${locale}/recover`);
    for (const rendered of [email, recovery]) {
      expect(rendered.subject).not.toMatch(/\?{2,}/u);
      expect(rendered.text).not.toMatch(/\?{2,}/u);
      if (locale === "ar") {
        expect(rendered.subject).toMatch(/[\u0600-\u06ff]/u);
        expect(rendered.text).toMatch(/[\u0600-\u06ff]/u);
      }
    }
  });

  it.each([
    { activationUrl: "https://foreign.example/en/activate/invitation_code_12345678" },
    { activationUrl: `https://password@${new URL(origin).host}/en/activate/${code}` },
    { activationUrl: `${origin}/en/activate/wrong_code_12345678` },
    { activationUrl: `${origin}/en/activate/${code}?redirect=evil` },
    { activationUrl: `javascript:alert(1)` },
    { activationCode: '<script>alert(1)</script>' },
    { expiresAt: now.toISOString() },
    { locale: "de" },
    { toEmail: "invalid" },
  ])("rejects unsafe or stale delivery before provider invocation", (overrides) => {
    expect(() => renderIdentityEmail(event.type, { ...invitation(), ...overrides }, origin, now)).toThrow(EmailDeliveryValidationError);
  });

  it("delivers each identity event through Resend with stable retry keys and distinct message keys", async () => {
    const emailTransport = vi.fn<HttpTransport>(() => Promise.resolve(response()));
    const inngestTransport = vi.fn<InngestTransport>(() => Promise.resolve(response()));
    const provider = new ResendEmailProvider({ RESEND_API_KEY: "test-key", EMAIL_FROM: "ops@example.test" }, emailTransport);
    // Dispatch persistence and duplicate suppression are exercised against real
    // PostgreSQL. This unit keeps the provider wire contract and legacy keys.
    const send = (source: typeof event) => provider.send({ ...renderIdentityEmail(source.type, source.payload, origin, now), idempotencyKey: emailIdempotencyKey(source) });
    await send(event);
    await send({ ...event, attemptCount: 1 });
    await send({ ...event, id: "018f0a0b-0000-7000-9000-000000000012" });
    const keys = emailTransport.mock.calls.map(([, request]) => request.headers?.["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).not.toContain("person@example.test");
    expect(inngestTransport).not.toHaveBeenCalled();
    const body: unknown = JSON.parse(emailTransport.mock.calls[0][1].body!);
    expect(body).toMatchObject({ to: ["person@example.test"], tags: [{ name: "template", value: "identity_invitation" }, { name: "locale", value: "en" }] });
  });

  it("keeps manual phone delivery in the existing event path", async () => {
    const inngestTransport = vi.fn<InngestTransport>(() => Promise.resolve({ ...response(), json: () => Promise.resolve({ ids: ["accepted-manual-reference"], status: 200 }) }));
    const handlers = createInngestOutboxHandlers({ INNGEST_EVENT_KEY: "test-event-key", APP_URL: origin }, inngestTransport);
    await handlers[event.type]({ ...event, payload: { channel: "manual_phone" } });
    expect(inngestTransport).toHaveBeenCalledOnce();
  });

  it("fails closed when the real email provider is missing", () => {
    expect(() => new ResendEmailProvider({})).toThrow("RESEND_API_KEY is required");
  });

  it("does not persist provider response bodies containing recipient or recovery secrets", async () => {
    const emailTransport = vi.fn<HttpTransport>(() => Promise.resolve({ ...response(), ok: false, status: 429, text: () => Promise.resolve('person@example.test secret-code') }));
    const provider = new ResendEmailProvider({ RESEND_API_KEY: "test-key", EMAIL_FROM: "ops@example.test" }, emailTransport);
    await expect(provider.send(renderIdentityEmail(event.type, invitation(), origin, now))).rejects.toThrow(/^Resend email request failed with status 429$/u);
  });

  it("uses content keys for legacy callers without grouping distinct messages to one recipient", async () => {
    const transport = vi.fn<HttpTransport>(() => Promise.resolve(response()));
    const provider = new ResendEmailProvider({ RESEND_API_KEY: "test-key", EMAIL_FROM: "ops@example.test" }, transport);
    const email = renderIdentityEmail(event.type, invitation(), origin, now);
    await provider.send(email);
    await provider.send({ template: email.template, locale: email.locale, to: email.to, subject: email.subject, html: email.html, text: email.text });
    await provider.send({ ...email, text: `${email.text}\nA distinct message` });
    const keys = transport.mock.calls.map(([, request]) => request.headers?.["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).toMatch(/^email:[0-9a-f]{64}$/u);
  });

  it("rejects invalid retry keys before contacting Resend", async () => {
    const transport = vi.fn<HttpTransport>(() => Promise.resolve(response()));
    const provider = new ResendEmailProvider({ RESEND_API_KEY: "test-key", EMAIL_FROM: "ops@example.test" }, transport);
    await expect(provider.send({ ...renderIdentityEmail(event.type, invitation(), origin, now), idempotencyKey: "unsafe\nheader" })).rejects.toThrow("Invalid email idempotency key");
    expect(transport).not.toHaveBeenCalled();
  });

  it("redacts transport and JSON parse errors", async () => {
    const transport = vi.fn<HttpTransport>().mockRejectedValueOnce(new Error("private-recipient@example.test secret-key"))
      .mockResolvedValueOnce({ ...response(), json: () => Promise.reject(new Error("private-recovery-code")) });
    const provider = new ResendEmailProvider({ RESEND_API_KEY: "test-key", EMAIL_FROM: "ops@example.test" }, transport);
    const email = renderIdentityEmail(event.type, invitation(), origin, now);
    await expect(provider.send(email)).rejects.toThrow(/^Resend email transport failed$/u);
    await expect(provider.send(email)).rejects.toThrow(/^Invalid Resend email response$/u);
  });
});
