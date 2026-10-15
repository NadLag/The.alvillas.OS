import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

if (!process.env.VERCEL_OIDC_TOKEN) process.loadEnvFile(".env.local");
const baseURL = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const storageState = process.env.STAGING_STORAGE_STATE_FILE;
const revokedStorageState = process.env.STAGING_REVOKE_STORAGE_STATE_FILE;
const resumedSessionId = process.env.STAGING_REVOKE_SESSION_ID;
const configuredOidc = process.env.VERCEL_OIDC_TOKEN;
if (!expectedSha || !configuredOidc) throw new Error("STAGING_EXPECTED_SHA and development VERCEL_OIDC_TOKEN are required");
const oidc: string = configuredOidc;
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL, storageState, viewport: { width: 1440, height: 1000 } });
async function protectOrigin(browserContext: typeof context) {
await browserContext.route("**/*", async (route) => {
  const request = route.request();
  const headers = request.headers();
  if (new URL(request.url()).origin === baseURL) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
  await route.continue({ headers });
});
}
await protectOrigin(context);
let revocationMutations = 0;
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
    if (revokedStorageState) {
      const victim = await browser.newContext({ baseURL, storageState: revokedStorageState });
      await protectOrigin(victim);
      try {
        const victimPage = await victim.newPage();
        const victimResponse = await victimPage.goto("/api/auth/session");
        const victimSession = await victimResponse?.json() as { user?: { id?: string; sessionId?: string } } | null;
        const actorResponse = await page.goto("/api/auth/session");
        const actorSession = await actorResponse?.json() as { user?: { id?: string; email?: string; sessionId?: string } } | null;
        if (!actorSession?.user?.id || !actorSession.user.email) throw new Error("The real owner actor session is required");
        if (victimSession?.user?.id) expect(victimSession.user.id).toBe(actorSession.user.id);
        const targetSessionId = victimSession?.user?.sessionId || resumedSessionId;
        if (!targetSessionId || !/^[0-9a-f-]{36}$/u.test(targetSessionId) || targetSessionId === actorSession.user.sessionId) throw new Error("Revocation acceptance requires a distinct real owner session, or its exact ID when resuming a completed revoke");
        const victimDevice = (await victim.cookies()).find((cookie) => cookie.name === "alvillas_device_id")?.value;
        const actorDevice = (await context.cookies()).find((cookie) => cookie.name === "alvillas_device_id")?.value;
        if (!victimDevice || !actorDevice || victimDevice === actorDevice) throw new Error("Revocation acceptance requires two distinct real owner devices");
        await page.goto("/en/app/identity");
        await page.waitForLoadState("networkidle");
        const ownerAccount = page.getByTestId("identity-account-row").filter({ hasText: actorSession.user.email });
        await expect(ownerAccount).toHaveCount(1);
        const sessionRow = ownerAccount.locator(`[data-session-id="${targetSessionId}"]`);
        await expect(sessionRow).toBeVisible();
        if (await sessionRow.getByTestId("revoke-session-button").isEnabled()) {
          await sessionRow.getByTestId("revoke-session-button").click();
          revocationMutations += 1;
        }
        await expect(sessionRow).toContainText("REVOKED", { timeout: 20000 });
        await victimPage.goto("/en/app");
        await expect(victimPage).toHaveURL(/\/en\/login/u);
        const deniedResponse = await victimPage.goto("/api/auth/session");
        const denied = await deniedResponse?.json() as { user?: { id?: string } } | null;
        expect(denied?.user?.id).toBeFalsy();
        const deviceRow = ownerAccount.locator(`[data-device-id="${victimDevice}"]`);
        await expect(deviceRow).toBeVisible();
        if (await deviceRow.getByTestId("revoke-device-button").isEnabled()) {
          await deviceRow.getByTestId("revoke-device-button").click();
          revocationMutations += 1;
        }
        await expect(deviceRow).toContainText("REVOKED", { timeout: 20000 });
        await page.goto("/en/app/security");
        await expect(page.getByTestId("account-security-page")).toBeVisible();
      } finally { await victim.close(); }
    }
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
    keyboard: storageState ? "not executed" : "passed", accessibility: "axe passed", credentialChanges: 0,
    remoteSessionAndDeviceRevocation: revokedStorageState && storageState ? "passed using two real owner sessions" : "not executed",
    identityMutations: revocationMutations }));
} finally { await context.close(); await browser.close(); }
