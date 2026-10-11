import { describe, expect, it, vi } from "vitest";
import { captureException, parseSentryDsn, type SentryTransport } from "@/platform/observability/sentry";

describe("Sentry observability", () => {
  it("parses Sentry DSNs into envelope endpoints", () => {
    expect(parseSentryDsn("https://public@example.ingest.sentry.io/450123")).toMatchObject({
      publicKey: "public",
      projectId: "450123",
      envelopeUrl:
        "https://example.ingest.sentry.io/api/450123/envelope/?sentry_key=public&sentry_version=7&sentry_client=alvillas-os/0.0.0"
    });
  });

  it("skips capture when Sentry is not configured", async () => {
    await expect(
      captureException(new Error("boom"), { source: "job" }, { env: {} })
    ).resolves.toEqual({ sent: false, reason: "not_configured" });
  });

  it("sends redacted exception envelopes", async () => {
    const transport = vi.fn<SentryTransport>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("")
      })
    );

    await expect(
      captureException(
        new Error("boom"),
        {
          source: "api",
          requestId: "req-1",
          extra: { email: "owner@example.com", safe: "value" }
        },
        {
          env: {
            SENTRY_DSN: "https://public@example.ingest.sentry.io/450123",
            VERCEL_ENV: "preview"
          },
          transport,
          now: new Date("2026-10-11T00:00:00.000Z"),
          eventId: "018f0a0b-0000-7000-9000-000000000901"
        }
      )
    ).resolves.toMatchObject({ sent: true, status: 200 });

    const transportCalls = transport.mock.calls;
    const transportCall = transportCalls[0];

    expect(transportCall).toBeDefined();
    const body = transportCall?.[1].body;
    expect(body).toContain("\"requestId\":\"req-1\"");
    expect(body).toContain("\"email\":\"[redacted]\"");
    expect(body).not.toContain("owner@example.com");
  });
});
