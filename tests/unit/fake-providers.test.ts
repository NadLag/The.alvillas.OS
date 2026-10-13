import { describe, expect, it } from "vitest";
import {
  FakeEmailProvider,
  FakePdfRenderer,
  FakePaymentProvider,
  FakeRateLimiter,
  assertFakeProviderAllowed
} from "@/platform/providers/fakes";

describe("fake providers", () => {
  it("refuses fake providers in production", () => {
    expect(() => assertFakeProviderAllowed("production")).toThrow(
      "Fake providers cannot be used in production"
    );
  });

  it("records fake email sends for development verification", async () => {
    const provider = new FakeEmailProvider("test");

    await expect(
      provider.send({
        to: "owner@example.com",
        subject: "Hello",
        html: "<p>Hello</p>",
        locale: "en",
        template: "test.email"
      })
    ).resolves.toEqual({ id: "fake-email-1" });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ locale: "en", template: "test.email" });
  });

  it("includes locale in fake PDF payloads", async () => {
    const payload = await new FakePdfRenderer("test").render({
      template: "test.pdf",
      data: { name: "Villa A" },
      locale: "fr"
    });

    expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({
      template: "test.pdf",
      locale: "fr"
    });
  });

  it("returns deterministic fake payment ids", async () => {
    await expect(
      new FakePaymentProvider("test").record({
        amount: "10.00",
        currency: "MAD",
        source: "manual"
      })
    ).resolves.toEqual({ paymentId: "fake-payment-manual-MAD-10.00" });
  });

  it("allows fake rate limiting outside production only", async () => {
    await expect(
      new FakeRateLimiter("test").consume({ key: "dev", limit: 3, windowSeconds: 60 })
    ).resolves.toMatchObject({ allowed: true, remaining: 3 });
  });
});
