import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { totpCode } from "../src/platform/auth/totp";

process.loadEnvFile(".env.local");
const origin = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const stateFile = process.env.STAGING_STORAGE_STATE_FILE;
const oidc = process.env.VERCEL_OIDC_TOKEN;
if (!expectedSha || !oidc || !stateFile) throw new Error("Staging SHA, development OIDC token and private storage-state path are required");
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: stateFile, viewport: { width: 1440, height: 1000 } });
await context.route("**/*", async (route) => {
  const request = route.request();
  const headers = request.headers();
  if (new URL(request.url()).origin === origin) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
  await route.continue({ headers });
});
let restored = false;
let step = "version";
let originalLocale: string | undefined;
const page = await context.newPage();
try {
  const version = await (await page.goto("/api/version"))?.json() as { version: string; environment: string; commitRef: string };
  expect(version).toMatchObject({ version: expectedSha, environment: "preview", commitRef: "main" });
  step = "session";
  let session = await (await page.goto("/api/auth/session"))?.json() as { user?: { id?: string } };
  if (!session?.user?.id) {
    const passwordFile = process.env.STAGING_ADMIN_PASSWORD_FILE;
    const mfaFile = process.env.STAGING_ADMIN_MFA_FILE;
    if (!passwordFile || !mfaFile) throw new Error("The saved owner session expired. An existing owner sign-in is required; credentials will not be reset.");
    const password = (await readFile(passwordFile, "utf8")).trimEnd();
    const mfa = await readFile(mfaFile, "utf8");
    const email = mfa.match(/^email=(.+)$/mu)?.[1].trim();
    const secret = mfa.match(/^totp_secret=(.+)$/mu)?.[1].trim();
    if (!email || !secret) throw new Error("Existing owner credential files are incomplete");
    step = "existing-owner-sign-in";
    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-mfa-step")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("login-mfa-code").fill(totpCode(secret));
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/(en|fr|ar)\/app$/u, { timeout: 30000 });
    await context.storageState({ path: stateFile });
    session = await (await page.goto("/api/auth/session"))?.json() as typeof session;
  }
  expect(session.user?.id).toBeTruthy();
  if (process.env.STAGING_AUTH_ONLY === "1") {
    console.log(JSON.stringify({ authenticated: true, identityOrCredentialMutations: 0 }));
  } else {
    step = "notification-flow";
    await page.goto("/en/app");
    await expect(page.getByTestId("notification-count")).toBeVisible();
    const baseline = Number(await page.getByTestId("notification-count").textContent());
    originalLocale = await page.getByTestId("preferred-locale-select").inputValue();
    const nextLocale = originalLocale === "fr" ? "en" : "fr";
    await page.getByTestId("preferred-locale-select").selectOption(nextLocale);
    await page.getByTestId("preferred-locale-submit").click();
    await expect(page).toHaveURL(new RegExp(`/${nextLocale}/app$`, "u"));
    await expect(page.getByTestId("notification-count")).toHaveText(String(baseline + 1));
    await page.getByTestId("notification-bell").click();
    const newest = page.getByTestId("notification-item").first();
    await expect(newest).toContainText(nextLocale === "fr" ? "Votre langue préférée a été modifiée." : "Your language preference was updated.");
    await newest.getByRole("button", { name: nextLocale === "fr" ? "Marquer comme lue" : "Mark as read", exact: true }).click();
    await expect(page.getByTestId("notification-count")).toHaveText(String(baseline));
    await newest.getByRole("button", { name: nextLocale === "fr" ? "Ouvrir la fiche" : "Open record", exact: true }).click();
    await expect(page.getByTestId("notification-panel")).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${nextLocale}/app$`, "u"));
    await page.getByTestId("preferred-locale-select").selectOption(originalLocale);
    await page.getByTestId("preferred-locale-submit").click();
    await expect(page).toHaveURL(new RegExp(`/${originalLocale}/app$`, "u"));
    restored = true;
    await page.goto("/en/app");
    await page.getByTestId("notification-bell").click();
    await page.getByTestId("notification-item").first().getByRole("button", { name: "Mark as read", exact: true }).click();
    await expect(page.getByTestId("notification-count")).toHaveText(String(baseline));
    await page.keyboard.press("Escape");
    for (const width of [1440, 360]) for (const locale of ["en", "fr", "ar"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${locale}/app`);
      await expect(page.getByTestId("notification-count")).toHaveText(baseline.toLocaleString(locale));
      await page.getByTestId("notification-bell").click();
      await expect(page.getByTestId("notification-item").first()).toHaveAttribute("data-read", "true");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("notification-bell")).toBeFocused();
    }
    const fresh = await browser.newContext({ baseURL: origin, storageState: await context.storageState() });
    try {
      await fresh.route("**/*", async (route) => {
        const request = route.request(); const headers = request.headers();
        if (new URL(request.url()).origin === origin) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
        await route.continue({ headers });
      });
      const reopened = await fresh.newPage(); await reopened.goto("/en/app");
      await expect(reopened.getByTestId("notification-count")).toHaveText(String(baseline));
      await reopened.getByTestId("notification-bell").click();
      await expect(reopened.getByTestId("notification-item").first()).toHaveAttribute("data-read", "true");
    } finally { await fresh.close(); }
    await context.storageState({ path: stateFile });
    console.log(JSON.stringify({ sha: version.version, environment: version.environment, authenticated: true,
      realPreferenceEvents: 2, originalPreferenceRestored: restored, unreadCounts: "passed", readPersistence: "passed across browser contexts",
      authorizedNavigation: "passed", locales: "EN/FR/AR RTL", widths: "1440/360", accessibility: "axe passed", credentialChanges: 0 }));
  }
} catch {
  // Playwright assertion objects can include filled login fields. Never print them.
  console.error(JSON.stringify({ status: "failed", step, authenticatedStagingAcceptance: "incomplete" }));
  process.exitCode = 1;
} finally {
  if (originalLocale && !restored) {
    await page.keyboard.press("Escape");
    await page.goto("/en/app");
    await page.getByTestId("preferred-locale-select").selectOption(originalLocale);
    await page.getByTestId("preferred-locale-submit").click();
  }
  await context.close(); await browser.close();
}
