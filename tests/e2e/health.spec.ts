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

test("readiness endpoint reports database status", async ({ request }) => {
  const response = await request.get("/api/readiness");
  const body = (await response.json()) as {
    service: { service: string };
    checks: Array<{ name: string }>;
  };

  expect([200, 503]).toContain(response.status());
  expect(body).toMatchObject({
    service: { service: "alvillas-os" },
    checks: [expect.objectContaining({ name: "database" })]
  });
});
