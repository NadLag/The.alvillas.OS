import { describe, expect, it } from "vitest";
import { checkReadiness } from "@/platform/health/readiness";
import { readServiceInfo } from "@/platform/health/service-info";

const fixedNow = new Date("2026-10-11T12:00:00.000Z");

describe("service health metadata", () => {
  it("returns local defaults when deployment metadata is absent", () => {
    expect(readServiceInfo({}, fixedNow)).toEqual({
      service: "alvillas-os",
      environment: "development",
      version: "local",
      commitRef: "local",
      deploymentId: null,
      timestamp: "2026-10-11T12:00:00.000Z"
    });
  });

  it("uses Vercel deployment metadata when present", () => {
    expect(
      readServiceInfo(
        {
          VERCEL_ENV: "production",
          VERCEL_GIT_COMMIT_SHA: "abc123",
          VERCEL_GIT_COMMIT_REF: "main",
          VERCEL_DEPLOYMENT_ID: "dpl_123"
        },
        fixedNow
      )
    ).toMatchObject({
      environment: "production",
      version: "abc123",
      commitRef: "main",
      deploymentId: "dpl_123"
    });
  });
});

describe("readiness", () => {
  it("fails readiness when DATABASE_URL is missing", async () => {
    await expect(checkReadiness({ env: {}, now: fixedNow })).resolves.toMatchObject({
      status: "not_ready",
      checks: [{ name: "database", status: "missing" }]
    });
  });

  it("passes readiness when database migrations are visible", async () => {
    await expect(
      checkReadiness({
        env: { DATABASE_URL: "postgresql://localhost/alvillas_os" },
        now: fixedNow,
        migrationSummary: () => Promise.resolve({ migrationCount: 9 })
      })
    ).resolves.toMatchObject({
      status: "ready",
      checks: [{ name: "database", status: "ok", detail: "9 migrations applied" }]
    });
  });

  it("fails readiness when the database check errors", async () => {
    await expect(
      checkReadiness({
        env: { DATABASE_URL: "postgresql://localhost/alvillas_os" },
        now: fixedNow,
        migrationSummary: () => Promise.reject(new Error("connection refused"))
      })
    ).resolves.toMatchObject({
      status: "not_ready",
      checks: [{ name: "database", status: "error", detail: "connection refused" }]
    });
  });
});
