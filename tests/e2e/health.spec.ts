import { expect, test } from "@playwright/test";
import { readServiceInfo } from "@/platform/health/service-info";

test("health endpoint returns service status", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    status: "ok",
    service: "alvillas-os"
  });
});

test("version endpoint returns deployment metadata shape", async ({ request }) => {
  const response = await request.get("/api/version");
  const expected = readServiceInfo(process.env);

  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    service: expected.service,
    environment: expected.environment,
    version: expected.version,
    commitRef: expected.commitRef,
    deploymentId: expected.deploymentId
  });
});

test("readiness endpoint reports database status", async ({ request }) => {
  await expect
    .poll(
      async () => {
        const response = await request.get("/api/readiness");
        const contentType = response.headers()["content-type"] ?? "";

        if (!contentType.includes("application/json")) {
          return {
            ok: false,
            status: response.status(),
            contentType
          };
        }

        const body = (await response.json()) as {
          service?: { service?: string };
          checks?: Array<{ name?: string }>;
        };

        return {
          ok:
            [200, 503].includes(response.status()) &&
            body.service?.service === "alvillas-os" &&
            Boolean(body.checks?.some((check) => check.name === "database")),
          status: response.status(),
          contentType
        };
      },
      { timeout: 10000 }
    )
    .toMatchObject({ ok: true });
});
