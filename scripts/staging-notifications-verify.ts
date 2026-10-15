import { readFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { totpCode } from "../src/platform/auth/totp";

// Match the existing protected-staging verifier's remote navigation deadline.
// Assertions still require the committed read state and exact unread counts.
const expect = playwrightExpect.configure({ timeout: 30000 });

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
  } else if (process.env.STAGING_ROUTING_ONLY === "1") {
    const ids = ["notification-in-app-enabled", "notification-account", "notification-operations"] as const;
    const preferences: Record<string, boolean> = {};
    let originalChannel: boolean | undefined;
    const openRouting = async () => {
      await page.goto("/en/app/notifications");
      await expect(page.getByTestId("routing-in-app")).toBeVisible();
      await page.getByTestId("routing-event").selectOption("language_updated");
      await expect(page.getByTestId("routing-in-app")).toBeEnabled();
    };
    const saveRouting = async (checked: boolean, reason: string) => {
      await page.getByTestId("routing-in-app").setChecked(checked);
      await page.getByTestId("routing-reason").fill(reason);
      await page.getByTestId("routing-save").click();
      await expect(page.getByTestId("routing-status")).toContainText("Routing saved");
      await expect(page.getByTestId("routing-reason")).toHaveValue("");
    };
    const savePreferences = async () => {
      const button = page.getByTestId("notification-preferences-save");
      if (await button.isEnabled()) { await button.click(); await expect(button).toBeDisabled(); }
    };
    await page.goto("/en/app");
    originalLocale = await page.getByTestId("preferred-locale-select").inputValue();
    const nextLocale = originalLocale === "fr" ? "en" : "fr";
    try {
      step = "routing-capture-and-optional-preferences";
      await openRouting();
      for (const id of ids) { await expect(page.getByTestId(id)).toBeVisible(); preferences[id] = await page.getByTestId(id).isChecked(); }
      await page.getByTestId(ids[0]).check(); await page.getByTestId(ids[1]).check(); await savePreferences();
      originalChannel = await page.getByTestId("routing-in-app").isChecked();
      step = "routing-disable-channel";
      await saveRouting(false, "Staging acceptance: verify channel suppression");
      await page.goto("/en/app");
      await expect(page.getByTestId("notification-count")).toBeVisible();
      const baseline = Number(await page.getByTestId("notification-count").textContent());
      await page.getByTestId("preferred-locale-select").selectOption(nextLocale);
      await page.getByTestId("preferred-locale-submit").click();
      await expect(page).toHaveURL(new RegExp(`/${nextLocale}/app$`, "u"));
      await expect(page.getByTestId("notification-count")).toHaveText(String(baseline));
      step = "routing-enable-and-real-event";
      await openRouting(); await expect(page.getByTestId("routing-in-app")).not.toBeChecked();
      await saveRouting(true, "Staging acceptance: verify one real event delivery");
      await page.goto("/en/app");
      await page.getByTestId("preferred-locale-select").selectOption(originalLocale);
      await page.getByTestId("preferred-locale-submit").click();
      await expect(page).toHaveURL(new RegExp(`/${originalLocale}/app$`, "u"));
      await expect(page.getByTestId("notification-count")).toHaveText(String(baseline + 1));
      await page.goto("/en/app");
      await page.getByTestId("notification-bell").click();
      const notice = page.getByTestId("notification-item").first();
      await expect(notice).toContainText("Your language preference was updated.");
      await notice.getByRole("button", { name: "Mark as read", exact: true }).click();
      await expect(page.getByTestId("notification-count")).toHaveText(String(baseline));
      for (const width of [1440, 360]) for (const locale of ["en", "fr", "ar"]) {
        step = `routing-accessibility-${locale}-${width}`;
        await page.setViewportSize({ width, height: 900 }); await page.goto(`/${locale}/app/notifications`);
        await expect(page.getByTestId("routing-in-app")).toBeVisible();
        await page.getByTestId("routing-event").selectOption("security_session_revoked");
        await expect(page.getByTestId("routing-in-app")).toBeChecked(); await expect(page.getByTestId("routing-in-app")).toBeDisabled();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
    } finally {
      step = "restore-routing-and-preferences";
      if (originalChannel !== undefined) { await openRouting(); await saveRouting(originalChannel, "Restore original routing after staging acceptance"); }
      await page.goto("/en/app/notifications");
      if (Object.keys(preferences).length === ids.length) {
        await page.getByTestId(ids[0]).check();
        for (const id of ids.slice(1)) await page.getByTestId(id).setChecked(preferences[id]);
        await page.getByTestId(ids[0]).setChecked(preferences[ids[0]]); await savePreferences();
      }
    }
    await context.storageState({ path: stateFile });
    console.log(JSON.stringify({ sha: version.version, authenticated: true, routingPersistence: "passed", disabledChannel: "suppressed a real event",
      enabledChannel: "one real event, exact unread count and mark-read", mandatorySecurity: "checked and locked", locales: "EN/FR/AR RTL", widths: "1440/360",
      accessibility: "axe passed", originalRoutingAndPreferencesRestored: true, credentialChanges: 0, externalDeliveryClaimed: false }));
  } else if (process.env.STAGING_PREFERENCES_ONLY === "1") {
    step = "notification-settings";
    await page.goto("/en/app/notifications");
    const ids = ["notification-in-app-enabled", "notification-account", "notification-operations"] as const;
    const original: Record<string, boolean> = {};
    for (const id of ids) { await expect(page.getByTestId(id)).toBeVisible(); original[id] = await page.getByTestId(id).isChecked(); }
    const save = async () => {
      await page.getByTestId("notification-preferences-save").click();
      await expect(page.getByTestId("notification-preferences-save")).toBeDisabled();
      await expect(page.getByRole("status")).toContainText("Your preferences have been saved.");
    };
    const restore = async () => {
      await page.goto("/en/app/notifications");
      await expect(page.getByTestId(ids[0])).toBeVisible();
      await page.getByTestId(ids[0]).check();
      for (const id of ids.slice(1)) await page.getByTestId(id).setChecked(original[id]);
      await page.getByTestId(ids[0]).setChecked(original[ids[0]]);
      if (await page.getByTestId("notification-preferences-save").isEnabled()) await save();
      await page.reload();
      for (const id of ids) await expect(page.getByTestId(id)).toBeChecked({ checked: original[id] });
    };
    try {
      await page.getByTestId(ids[0]).check();
      await page.getByTestId(ids[1]).setChecked(!original[ids[1]]);
      await page.getByTestId(ids[2]).setChecked(!original[ids[2]]);
      await save();
      step = "fresh-context-preference-persistence";
      const fresh = await browser.newContext({ baseURL: origin, storageState: await context.storageState() });
      try {
        await fresh.route("**/*", async (route) => {
          const headers = route.request().headers();
          if (new URL(route.request().url()).origin === origin) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
          await route.continue({ headers });
        });
        const reopened = await fresh.newPage(); await reopened.goto("/en/app/notifications");
        await expect(reopened.getByTestId(ids[1])).toBeChecked({ checked: !original[ids[1]] });
        await expect(reopened.getByTestId(ids[2])).toBeChecked({ checked: !original[ids[2]] });
      } finally { await fresh.close(); }
      step = "channel-and-security-policy";
      await page.getByTestId(ids[0]).uncheck(); await save();
      for (const width of [1440, 360]) for (const locale of ["en", "fr", "ar"]) {
        step = `settings-accessibility-${locale}-${width}`;
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${locale}/app/notifications`);
        await expect(page.getByTestId(ids[0])).not.toBeChecked();
        await expect(page.getByTestId(ids[1])).toBeDisabled();
        for (const id of ["notification-security-in-app", "notification-security-email"]) {
          await expect(page.getByTestId(id)).toBeChecked(); await expect(page.getByTestId(id)).toBeDisabled();
        }
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
    } finally { step = "restore-original-notification-preferences"; await restore(); }
    await context.storageState({ path: stateFile });
    console.log(JSON.stringify({ sha: version.version, environment: version.environment, authenticated: true,
      preferencePersistence: "passed across browser contexts", channelAndCategoryChoices: "passed", mandatorySecurity: "checked and locked",
      locales: "EN/FR/AR RTL", widths: "1440/360", accessibility: "axe passed", originalNotificationPreferencesRestored: true,
      credentialChanges: 0, externalDeliveryClaimed: false }));
  } else {
    step = "open-workspace";
    await page.goto("/en/app");
    await expect(page.getByTestId("notification-count")).toBeVisible();
    const baseline = Number(await page.getByTestId("notification-count").textContent());
    originalLocale = await page.getByTestId("preferred-locale-select").inputValue();
    console.log(JSON.stringify({ step: "preference-captured", originalLocale, baseline }));
    const nextLocale = originalLocale === "fr" ? "en" : "fr";
    step = "change-preference";
    await page.getByTestId("preferred-locale-select").selectOption(nextLocale);
    await page.getByTestId("preferred-locale-submit").click();
    await expect(page).toHaveURL(new RegExp(`/${nextLocale}/app$`, "u"));
    step = "updated-unread-count";
    await expect(page.getByTestId("notification-count")).toHaveText(String(baseline + 1));
    await page.getByTestId("notification-bell").click();
    step = "open-panel";
    const newest = page.getByTestId("notification-item").first();
    await expect(newest).toContainText(nextLocale === "fr" ? "Votre langue préférée a été modifiée." : "Your language preference was updated.");
    step = "mark-read";
    await newest.getByRole("button", { name: nextLocale === "fr" ? "Marquer comme lue" : "Mark as read", exact: true }).click();
    await expect(page.getByTestId("notification-count")).toHaveText(String(baseline));
    step = "open-record";
    await newest.getByRole("button", { name: nextLocale === "fr" ? "Ouvrir la fiche" : "Open record", exact: true }).click();
    await expect(page.getByTestId("notification-panel")).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${nextLocale}/app$`, "u"));
    step = "restore-preference";
    await page.getByTestId("preferred-locale-select").selectOption(originalLocale);
    await page.getByTestId("preferred-locale-submit").click();
    await expect(page).toHaveURL(new RegExp(`/${originalLocale}/app$`, "u"));
    restored = true;
    step = "read-restoration-event";
    await page.goto("/en/app");
    await page.getByTestId("notification-bell").click();
    await page.getByTestId("notification-item").first().getByRole("button", { name: "Mark as read", exact: true }).click();
    await expect(page.getByTestId("notification-count")).toHaveText(String(baseline));
    await page.keyboard.press("Escape");
    for (const width of [1440, 360]) for (const locale of ["en", "fr", "ar"]) {
      step = `accessibility-${locale}-${width}`;
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
    step = "fresh-context-persistence";
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
} catch (error) {
  // Playwright assertion objects can include filled login fields. Never print them.
  const firstLine = error instanceof Error ? error.message.split("\n")[0] : "";
  console.error(JSON.stringify({ status: "failed", step, originalLocale, restored, assertion: firstLine.startsWith("expect(") ? firstLine : "browser action failed", authenticatedStagingAcceptance: "incomplete" }));
  process.exitCode = 1;
} finally {
  if (originalLocale && !restored) {
    try {
      const cleanupPage = await context.newPage();
      await cleanupPage.goto("/en/app");
      if (await cleanupPage.getByTestId("preferred-locale-select").inputValue() !== originalLocale) {
        await cleanupPage.getByTestId("preferred-locale-select").selectOption(originalLocale);
        const saved = cleanupPage.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).origin === origin);
        await cleanupPage.getByTestId("preferred-locale-submit").click();
        await (await saved).finished();
        await expect(cleanupPage).toHaveURL(new RegExp(`/${originalLocale}/app$`, "u"));
      }
      await cleanupPage.close();
    } catch { console.error(JSON.stringify({ preferenceRestoration: "requires-verification" })); }
  }
  await context.close(); await browser.close();
}
