import { describe, expect, it } from "vitest";
import { readEnv, validateRuntimeEnv } from "@/platform/env/env";

describe("environment validation", () => {
  it("parses optional provider variables without printing values", () => {
    expect(
      readEnv({
        APP_URL: "https://app.example.test",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com"
      } as unknown as NodeJS.ProcessEnv)
    ).toMatchObject({
      APP_URL: "https://app.example.test",
      PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com"
    });
  });

  it("requires production-critical environment variables at runtime", () => {
    const result = validateRuntimeEnv({
      NODE_ENV: "production",
      VERCEL_ENV: "production"
    } as unknown as NodeJS.ProcessEnv);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "DATABASE_URL", severity: "error" }),
        expect.objectContaining({ key: "AUTH_SECRET", severity: "error" }),
        expect.objectContaining({ key: "ENCRYPTION_KEYS", severity: "error" })
      ])
    );
  });

  it("warns when server Sentry is configured without browser Sentry", () => {
    expect(
      validateRuntimeEnv({
        SENTRY_DSN: "https://public@example.ingest.sentry.io/450123"
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual({
      ok: true,
      issues: [
        expect.objectContaining({
          key: "NEXT_PUBLIC_SENTRY_DSN",
          severity: "warning"
        })
      ]
    });
  });
});
