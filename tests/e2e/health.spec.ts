import { expect, test } from "@playwright/test";

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
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    service: "alvillas-os",
    environment: "development",
    version: "local",
    commitRef: "local",
    deploymentId: null
  });
});

test("readiness endpoint reports missing database locally", async ({ request }) => {
  const response = await request.get("/api/readiness");
  expect(response.status()).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    status: "not_ready",
    service: { service: "alvillas-os" },
    checks: [{ name: "database", status: "missing" }]
  });
});
