import { expect, test } from "@playwright/test";

test("public pages retain hydration and private entry points enforce a per-request script nonce", async ({ page, request }) => {
  const publicResponse = await page.goto("/en");
  expect(publicResponse?.headers()["content-security-policy"]).toContain("script-src-attr 'none'");
  await expect(page.getByTestId("home-sign-in")).toBeVisible();

  const first = await page.goto("/fr/login");
  const headers = first?.headers();
  const policy = headers?.["content-security-policy"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/]+)'/u.exec(policy)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("'strict-dynamic'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(headers?.["x-content-type-options"]).toBe("nosniff");
  expect(headers?.["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByTestId("login-email")).toBeVisible();
  const html = await first?.text();
  expect(html).toBeTruthy();
  const scriptNonces = await page.evaluate((markup) => {
    const documentFromResponse = new DOMParser().parseFromString(markup ?? "", "text/html");
    return [...documentFromResponse.scripts]
      .filter((script) => script.type !== "application/json")
      .map((script) => script.nonce);
  }, html);
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(new Set(scriptNonces)).toEqual(new Set([nonce]));
  const next = await request.get("/fr/login");
  expect(next.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(health.headers()["x-frame-options"]).toBe("DENY");
});
