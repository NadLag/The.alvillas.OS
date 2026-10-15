import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const expect = playwrightExpect.configure({ timeout: 30000 });
process.loadEnvFile(".env.local");
const origin = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const stateFile = process.env.STAGING_STORAGE_STATE_FILE;
const oidc = process.env.VERCEL_OIDC_TOKEN;
if (!expectedSha || !stateFile || !oidc) throw new Error("Existing staging authentication, expected version and development OIDC are required");
const browser = await chromium.launch({ channel: "chromium" });
const context = await browser.newContext({ baseURL: origin, storageState: stateFile, viewport: { width: 1440, height: 1000 } });
await context.route(`${origin}/**`, async (route) => {
  await route.continue({ headers: { ...route.request().headers(), "x-vercel-trusted-oidc-idp-token": oidc } });
});
await context.grantPermissions(["notifications"], { origin });
const page = await context.newPage();
let step = "version";
try {
  expect(await (await page.goto("/api/version"))?.json()).toMatchObject({ version: expectedSha, commitRef: "main", environment: "preview" });
  step = "existing-authentication";
  const session = await (await page.goto("/api/auth/session"))?.json() as { user?: { id?: string; securitySetupRequired?: boolean } };
  if (!session.user?.id || session.user.securitySetupRequired) throw new Error("Existing enrolled owner sign-in is required");
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const locale of ["en", "fr", "ar"]) {
      step = `browser-controls-${locale}-${width}`;
      await page.goto(`/${locale}/app/notifications`); await expect(page.getByTestId("push-enable")).toBeEnabled();
      await expect(page.getByTestId("push-not-configured")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  }
  step = "browser-denial";
  await page.goto("/en/app/notifications"); await expect(page.getByTestId("push-enable")).toBeEnabled();
  const cdp = await context.newCDPSession(page);
  const browserContextId = (await cdp.send("Target.getTargetInfo")).targetInfo.browserContextId;
  await cdp.send("Browser.setPermission", { browserContextId, permission: { name: "notifications" }, setting: "denied", origin });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("push-permission")).toContainText("Notifications are blocked.");
  await expect(page.getByTestId("push-enable")).toBeDisabled();
  await expect(page.getByTestId("notification-security-in-app")).toBeChecked();
  await expect(page.getByTestId("notification-security-in-app")).toBeDisabled();
  await cdp.detach();
  console.log(JSON.stringify({ authenticated: true, vapidConfigured: true, browserPermissionDenial: true, locales: ["en", "fr", "ar"], widths: [1440, 360], axeViolations: 0,
    credentialMutations: 0, financialMutations: 0, externalDeliveryClaimed: false }));
} catch { console.error(JSON.stringify({ step, status: "failed" })); process.exitCode = 1; }
finally { await context.close(); await browser.close(); }
