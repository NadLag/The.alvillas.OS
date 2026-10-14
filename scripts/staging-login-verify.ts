import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { chromium, expect, type Page } from "@playwright/test";
import { totpCode } from "../src/platform/auth/totp";

const baseURL = process.env.STAGING_BASE_URL;
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const passwordFile = process.env.STAGING_ADMIN_PASSWORD_FILE;
const mfaFile = process.env.STAGING_ADMIN_MFA_FILE;
const oidc = process.env.VERCEL_OIDC_TOKEN;
if (!baseURL || new URL(baseURL).hostname !== "the-alvillas-os-staging.vercel.app") throw new Error("The authorized staging URL is required");
if (!expectedSha || !passwordFile || !mfaFile || !oidc) throw new Error("Staging SHA, credential files and development OIDC token are required");
const password = (await readFile(passwordFile, "utf8")).trimEnd();
const mfa = await readFile(mfaFile, "utf8");
const secret = mfa.match(/^totp_secret=(.+)$/mu)?.[1].trim();
const email = process.env.STAGING_ADMIN_EMAIL ?? mfa.match(/^email=(.+)$/mu)?.[1].trim();
if (!secret || !email) throw new Error("Staging MFA credential file is incomplete");
const adminEmail = email;
const adminSecret = secret;
const browser = await chromium.launch();
const origin = new URL(baseURL).origin;
let lastAdminLogin = 0;

async function loginAdmin(page: Page): Promise<void> {
  // Respect the staging login limiter while exercising repeated authenticated sessions.
  const delay = Math.max(0, lastAdminLogin + 31_000 - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastAdminLogin = Date.now();
  await page.goto("/en/login");
  await expect(page.getByTestId("login-mfa-code")).toHaveCount(0);
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-mfa-step")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-mfa-code").fill(totpCode(adminSecret));
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/(en|fr|ar)\/app/u, { timeout: 30_000 });
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function logout(page: Page): Promise<void> {
  await page.getByTestId("logout-button").click();
  await expect(page).toHaveURL(/\/(en|fr|ar)\/login/u, { timeout: 30_000 });
  await page.goto("/en/app");
  await expect(page).toHaveURL(/\/en\/login/u);
}

const desktop = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
await desktop.route("**/*", async (route) => {
  const request = route.request();
  const headers = request.headers();
  if (new URL(request.url()).origin === origin) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
  await route.continue({ headers });
});
try {
  const page = await desktop.newPage();
  const versionResponse = await page.goto("/api/version");
  const version = await versionResponse?.json() as { version: string; environment: string; commitRef: string };
  expect(version.version).toBe(expectedSha);
  expect(version.environment).toBe("preview");
  expect(version.commitRef).toBe("main");
  for (const locale of ["en", "fr", "ar"]) {
    await page.goto(`/${locale}`);
    await page.getByTestId("home-sign-in").click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("login-email")).toBeVisible();
    await page.getByTestId("login-recover-link").click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/recover$`, "u"));
    await expect(page.getByTestId("recovery-email")).toBeVisible();
  }
  if (process.env.STAGING_PUBLIC_ONLY === "1") {
    await page.setViewportSize({ width: 360, height: 760 });
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`/${locale}`);
      await page.getByTestId("home-sign-in-nav").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByTestId("login-email").focus();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("login-password")).toBeFocused();
      await page.locator('input[name="method"][value="pin"]').check();
      await expect(page.getByTestId("login-phone")).toBeVisible();
      await expect(page.getByTestId("login-pin")).toBeVisible();
    }
    console.log(JSON.stringify({ stagingUrl: baseURL, sha: version.version, environment: version.environment,
      landingSignIn: "passed", recoveryLinks: "passed", locales: "EN/FR/AR RTL",
      viewport: "360px", keyboard: "passed", phonePinForm: "passed", authenticatedFlows: "not executed" }));
  } else {
  await loginAdmin(page);
  const sessionCookies = (await desktop.cookies()).filter((cookie) => cookie.name.includes("session-token"));
  expect(sessionCookies.length).toBeGreaterThan(0);
  for (const cookie of sessionCookies) {
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
  }
  await logout(page);
  await loginAdmin(page);

  // Exercise only a new staging verification account; existing business rows remain intact.
  const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const fieldEmail = `login-verification-${unique}@example.test`;
  const fieldPhone = `+2126${Date.now().toString().slice(-8)}`;
  const fieldPassword = randomBytes(24).toString("base64url");
  const fieldPin = String(100000 + randomBytes(4).readUInt32BE() % 900000);
  await page.goto("/en/app/identity");
  await page.getByTestId("invite-display-name").fill(`Staging login verification ${unique}`);
  await page.getByTestId("invite-email").fill(fieldEmail);
  await page.getByTestId("invite-phone").fill(fieldPhone);
  await page.getByTestId("invite-role").selectOption("field_staff");
  await page.getByTestId("invite-submit").click();
  const invitationText = await page.getByTestId("invitation-code").innerText();
  const invitationCode = invitationText.split(":").pop()?.trim();
  if (!invitationCode) throw new Error("Verification invitation was not issued");
  await logout(page);
  await page.goto(`/en/activate/${invitationCode}`);
  await page.getByTestId("activation-phone").fill(fieldPhone);
  await page.getByTestId("activation-pin").fill(fieldPin);
  await page.getByTestId("activation-password").fill(fieldPassword);
  await page.getByTestId("activation-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u, { timeout: 30_000 });
  await logout(page);
  await loginAdmin(page);
  await page.goto("/en/app/identity");
  const row = page.getByTestId("identity-account-row").filter({ hasText: fieldEmail });
  await row.getByTestId("issue-recovery-button").click();
  const recoveryText = await row.getByTestId("recovery-code").innerText();
  const recoveryCode = recoveryText.split(":").pop()?.trim();
  if (!recoveryCode) throw new Error("Verification recovery code was not issued");
  await logout(page);
  const recoveredPassword = randomBytes(24).toString("base64url");
  await page.goto("/en/recover");
  await page.getByTestId("recovery-email").fill(fieldEmail);
  await page.getByTestId("recovery-code-input").fill(recoveryCode);
  await page.getByTestId("recovery-password").fill(recoveredPassword);
  await page.getByTestId("recovery-submit").click();
  await expect(page).toHaveURL(/\/en\/login/u, { timeout: 30_000 });
  await page.getByTestId("login-email").fill(fieldEmail);
  await page.getByTestId("login-password").fill(recoveredPassword);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u, { timeout: 30_000 });
  await logout(page);

  const mobile = await browser.newContext({ baseURL, viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true });
  await mobile.route("**/*", async (route) => {
    const request = route.request();
    const headers = request.headers();
    if (new URL(request.url()).origin === origin) headers["x-vercel-trusted-oidc-idp-token"] = oidc;
    await route.continue({ headers });
  });
  try {
    const mobilePage = await mobile.newPage();
    for (const locale of ["en", "fr", "ar"]) {
      await mobilePage.goto(`/${locale}/login`);
      expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await mobilePage.getByTestId("login-email").focus();
      await mobilePage.keyboard.press("Tab");
      await expect(mobilePage.getByTestId("login-password")).toBeFocused();
    }
    await loginAdmin(mobilePage);
    await logout(mobilePage);
    await mobilePage.locator('input[name="method"][value="pin"]').check();
    await mobilePage.getByTestId("login-phone").fill(fieldPhone);
    await mobilePage.getByTestId("login-pin").fill(fieldPin);
    await mobilePage.getByTestId("login-submit").click();
    await expect(mobilePage).toHaveURL(/\/en\/app/u, { timeout: 30_000 });
    await expect(mobilePage.getByTestId("app-shell")).toBeVisible();
    await logout(mobilePage);
  } finally {
    await mobile.close();
  }
  await loginAdmin(page);
  await page.goto("/en/app/identity");
  await page.getByTestId("identity-account-row").filter({ hasText: fieldEmail }).getByTestId("deactivate-account-button").click();
  await expect(page.getByTestId("identity-account-row").filter({ hasText: fieldEmail })).toContainText("DEACTIVATED");
  await logout(page);
  console.log(JSON.stringify({ stagingUrl: baseURL, sha: version.version, environment: version.environment,
    emailPasswordMfaDashboardLogout: "passed", phonePinMobile: "passed", recovery: "passed",
    locales: "EN/FR/AR RTL", viewport: "360px", keyboard: "passed", secureCookies: "passed",
    landingSignIn: "passed", protection: "origin-scoped development OIDC", providerEmailDelivery: "not verified" }));
  }
} finally {
  await desktop.close();
  await browser.close();
}
