import { describe, expect, it, vi } from "vitest";
import {
  consumeRateLimit,
  hashRateLimitKey,
  rateLimitWindowStart,
  type RateLimitClient
} from "@/platform/rate-limit/postgres-rate-limiter";

describe("Postgres rate limiter", () => {
  it("hashes raw limiter keys before storage", () => {
    const hash = hashRateLimitKey("login:admin@example.com");

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain("admin@example.com");
  });

  it("floors timestamps to the limiter window", () => {
    expect(rateLimitWindowStart(new Date("2026-10-11T10:05:45.000Z"), 60).toISOString()).toBe(
      "2026-10-11T10:05:00.000Z"
    );
  });

  it("allows requests at or below the configured limit", async () => {
    const client = {
      $queryRaw: vi.fn(() =>
        Promise.resolve([{ count: 3, window_start: new Date("2026-10-11T10:05:00.000Z") }])
      )
    } satisfies RateLimitClient;

    await expect(
      consumeRateLimit(client, "018f0a0b-0000-7000-9000-000000000001", {
        key: "login:admin@example.com",
        limit: 3,
        windowSeconds: 60,
        now: new Date("2026-10-11T10:05:45.000Z")
      })
    ).resolves.toEqual({
      allowed: true,
      remaining: 0,
      resetAt: new Date("2026-10-11T10:06:00.000Z")
    });
  });

  it("blocks requests above the configured limit", async () => {
    const client = {
      $queryRaw: vi.fn(() =>
        Promise.resolve([{ count: 4, window_start: new Date("2026-10-11T10:05:00.000Z") }])
      )
    } satisfies RateLimitClient;

    await expect(
      consumeRateLimit(client, "018f0a0b-0000-7000-9000-000000000001", {
        key: "pin:+212600000000",
        limit: 3,
        windowSeconds: 60,
        now: new Date("2026-10-11T10:05:45.000Z")
      })
    ).resolves.toMatchObject({
      allowed: false,
      remaining: 0
    });
  });
});
