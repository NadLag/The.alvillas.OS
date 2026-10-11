import { describe, expect, it, vi } from "vitest";
import { StructuredLogger, redactSensitiveData } from "@/platform/observability/logger";

describe("StructuredLogger", () => {
  it("writes JSON logs with request and organization context", () => {
    const info = vi.fn();
    const logger = new StructuredLogger(
      { log: vi.fn(), info },
      () => new Date("2026-10-11T00:00:00.000Z")
    );

    logger.info(
      "health check",
      { requestId: "req-1", organizationId: "org-1", userId: "user-1" },
      { route: "/api/health" }
    );

    expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toEqual({
      level: "info",
      message: "health check",
      time: "2026-10-11T00:00:00.000Z",
      requestId: "req-1",
      organizationId: "org-1",
      userId: "user-1",
      data: { route: "/api/health" }
    });
  });

  it("redacts sensitive metadata keys", () => {
    const error = vi.fn();
    const logger = new StructuredLogger({ log: vi.fn(), error });

    logger.error("login failed", {}, { email: "owner@example.com", nested: { apiToken: "token" } });
    const parsed = JSON.parse(error.mock.calls[0]?.[0] as string) as { data: unknown };

    expect(parsed.data).toEqual({
      email: "[redacted]",
      nested: { apiToken: "[redacted]" }
    });
  });

  it("exports the same redaction helper for non-log observability payloads", () => {
    expect(
      redactSensitiveData({ password: "secret", safe: "value", nested: { phone: "+212600000000" } })
    ).toEqual({
      password: "[redacted]",
      safe: "value",
      nested: { phone: "[redacted]" }
    });
  });
});
