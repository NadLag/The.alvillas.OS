import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

if (!process.env.VERCEL_OIDC_TOKEN) process.loadEnvFile(".env.local");
const baseURL = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const storageState = process.env.STAGING_STORAGE_STATE_FILE;
const oidc = process.env.VERCEL_OIDC_TOKEN;
if (!expectedSha || !oidc) throw new Error("STAGING_EXPECTED_SHA and development VERCEL_OIDC_TOKEN are required");
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL, storageState, viewport: { width: 1440, height: 1000 } });
await context.route("**/*", async (route) => {
  const request = route.request();
  const headers = request.headers();
  if (new URL(request.url()).origin === baseURL) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
  await route.continue({ headers });
});
try {
  const page = await context.newPage();
  const response = await page.goto("/api/version");
  const version = await response?.json() as { version: string; environment: string; commitRef: string };
  expect(version).toMatchObject({ version: expectedSha, environment: "preview", commitRef: "main" });
  if (storageState) {
    const sessionResponse = await page.goto("/api/auth/session");
    const session = await sessionResponse?.json() as { user?: { id?: string } } | null;
    if (!session?.user?.id) throw new Error("The owner session expired or was revoked; sign in with the enrolled authenticator again");
    const cookies = (await context.cookies()).filter((cookie) => cookie.name.includes("session-token"));
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie.secure).toBe(true);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
    }
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const locale of ["en", "fr", "ar"]) {
        await page.goto(`/${locale}/app/security`);
        await expect(page.getByTestId("account-security-page")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
    }
    await page.goto("/en/app/identity");
    await expect(page.getByTestId("identity-page")).toBeVisible();
    await expect(page.getByTestId("person-create-form")).toBeVisible();
  } else {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const locale of ["en", "fr", "ar"]) {
        await page.goto(`/${locale}/login`);
        await expect(page.getByTestId("login-passkey")).toBeVisible();
        await expect(page.getByTestId("login-passkey")).toBeDisabled();
        await page.getByTestId("login-email").fill("unregistered-acceptance@example.test");
        await expect(page.getByTestId("login-passkey")).toBeEnabled();
        await page.getByTestId("login-email").focus();
        await page.keyboard.press("Tab");
        await expect(page.getByTestId("login-password")).toBeFocused();
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.locator('input[name="method"][value="pin"]').check();
        await expect(page.getByTestId("login-phone")).toBeVisible();
        await expect(page.getByTestId("login-pin")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    }
  }
  console.log(JSON.stringify({ sha: version.version, environment: version.environment, stagingUrl: baseURL,
    authenticatedReadAcceptance: storageState ? "passed using the supplied owner session" : "blocked: STAGING_STORAGE_STATE_FILE is required",
    publicLoginAcceptance: storageState ? "not executed" : "passed", locales: "EN/FR/AR RTL", widths: "1440/360",
    keyboard: storageState ? "not executed" : "passed", accessibility: "axe passed", credentialChanges: 0, identityMutations: 0 }));
} finally { await context.close(); await browser.close(); }
