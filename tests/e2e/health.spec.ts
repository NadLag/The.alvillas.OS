import { expect, test } from "@playwright/test";

test("health endpoint returns service status", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    status: "ok",
    service: "alvillas-os"
  });
});
