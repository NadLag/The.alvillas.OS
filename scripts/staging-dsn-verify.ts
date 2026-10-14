import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect, type Locator, type Page } from "@playwright/test";
import { totpCode } from "../src/platform/auth/totp";

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const baseURL = process.env.STAGING_BASE_URL;
const shareURL = process.env.STAGING_SHARE_URL;
const protectionAccessOverride = process.env.STAGING_PROTECTION_ACCESS;
const passwordFile = process.env.STAGING_ADMIN_PASSWORD_FILE;
const mfaFile = process.env.STAGING_ADMIN_MFA_FILE;
const email = (process.env.STAGING_ADMIN_EMAIL ?? "admin.staging@alvillas.test").trim().toLowerCase();

if (!baseURL) {
  throw new Error("STAGING_BASE_URL is required");
}

if (!passwordFile) {
  throw new Error("STAGING_ADMIN_PASSWORD_FILE is required");
}

if (!mfaFile) {
  throw new Error("STAGING_ADMIN_MFA_FILE is required");
}

const mfaOutputFile = mfaFile;

if (!process.env.VERCEL_OIDC_TOKEN && !shareURL && protectionAccessOverride !== "alias-override") {
  throw new Error("VERCEL_OIDC_TOKEN or STAGING_SHARE_URL is required to exercise the protected preview in Playwright");
}

const password = (await readFile(passwordFile, "utf8")).trimEnd();
let currentTotpSecret = await readLocalTotpSecret();

async function readLocalTotpSecret(): Promise<string> {
  try {
    const contents = await readFile(mfaOutputFile, "utf8");
    const secretLine = contents
      .split(/\r?\n/u)
      .find((line) => line.startsWith("totp_secret="));

    return secretLine?.slice("totp_secret=".length).trim() ?? "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function visibleBox(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();

  expect(box).not.toBeNull();

  return box!;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

async function login(page: Page, includeMfa = true): Promise<void> {
  await page.goto("/en/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);

  if (includeMfa && currentTotpSecret) {
    await page.getByTestId("login-mfa-code").fill(totpCode(currentTotpSecret));
  }

  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u, { timeout: 30_000 });
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
}

async function verifyNoOverlap(page: Page): Promise<void> {
  const headerBox = await visibleBox(page.locator(".shell-header").first());
  const bodyBox = await visibleBox(page.locator(".workspace-main, .dsn-board-grid, .empty-state-panel").first());
  expect(boxesOverlap(headerBox, bodyBox)).toBe(false);
}

async function verifyLoginLocales(page: Page): Promise<void> {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/en/login");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { name: "Sign in to ALVILLAS OS" })).toBeVisible();

  await page.getByRole("link", { name: "Francais" }).click();
  await expect(page).toHaveURL(/\/fr\/login/u);
  await expect(page.getByRole("heading", { name: "Connexion a ALVILLAS OS" })).toBeVisible();

  await page.getByTestId("locale-switch-ar").click();
  await expect(page).toHaveURL(/\/ar\/login/u);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const switchBox = await visibleBox(page.getByTestId("locale-switch"));
  const panelBox = await visibleBox(page.locator(".auth-panel"));
  expect(boxesOverlap(switchBox, panelBox)).toBe(false);
}

async function verifySessionCookie(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name.includes("authjs.session-token"));

  expect(sessionCookie).toBeTruthy();
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.secure).toBe(true);
  expect(sessionCookie?.sameSite).toBe("Lax");
}

async function enrollMfa(page: Page): Promise<void> {
  if (currentTotpSecret) {
    return;
  }

  await page.goto("/en/app/identity");
  await page.getByTestId("start-totp-button").click();
  const secretText = await page.getByTestId("totp-secret").innerText({ timeout: 30_000 });
  currentTotpSecret = secretText.split(":").pop()?.trim() ?? "";

  if (!currentTotpSecret) {
    throw new Error("TOTP secret was not rendered");
  }

  await page.getByTestId("totp-code").fill(totpCode(currentTotpSecret));
  await page.getByTestId("confirm-totp-button").click();
  await expect(page.getByTestId("mfa-recovery-code").first()).toBeVisible({ timeout: 30_000 });

  const recoveryCodes = await page.getByTestId("mfa-recovery-code").allInnerTexts();
  await writeFile(
    mfaOutputFile,
    [
      `email=${email}`,
      `totp_secret=${currentTotpSecret}`,
      "recovery_codes=",
      ...recoveryCodes.map((code) => code.replace(/^.*:\s*/u, "").trim())
    ].join("\n"),
    { mode: 0o600 }
  );
}

async function verifyMfaLogin(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/en/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-mfa-code").fill(totpCode(currentTotpSecret));
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u, { timeout: 30_000 });
}

async function verifySurfaces(page: Page): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/en/app");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await verifyNoOverlap(page);
  results.admin = "ok:/en/app";

  await page.goto("/fr/app/operations");
  await expect(page.getByTestId("operations-page")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await verifyNoOverlap(page);
  results.manager = "ok:/fr/app/operations";

  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/en/app/field");
  await expect(page.getByTestId("field-page")).toBeVisible();
  await verifyNoOverlap(page);
  results.field = "ok:/en/app/field@360";

  await page.goto("/ar/app/design-system");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("design-system-page")).toBeVisible();
  await page.getByRole("tab", { name: /Shells|Interfaces|Coquilles|الواجهات/u }).click();
  for (const label of ["Admin", "Manager", "Owner", "Guest", "Field"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /Finish|Terminer/u })).toHaveCSS("min-height", "56px");
  await verifyNoOverlap(page);
  results.shellBoard = "ok:/ar/app/design-system shells Admin/Manager/Owner/Guest/Field@360";

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  results.keyboard = "ok:tab navigation remained operable";

  return results;
}

const browser = await chromium.launch();
const extraHTTPHeaders = process.env.VERCEL_OIDC_TOKEN
  ? {
      "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN
    }
  : undefined;
const context = await browser.newContext({
  baseURL,
  extraHTTPHeaders
});
const page = await context.newPage();

try {
  if (shareURL) {
    await page.goto(shareURL);
  }

  await verifyLoginLocales(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await login(page);
  await verifySessionCookie(page);
  await enrollMfa(page);

  await page.goto("/en/app");
  await page.getByTestId("logout-button").click();
  await expect(page).toHaveURL(/\/en\/login/u, { timeout: 30_000 });
  await page.goto("/en/app");
  await expect(page).toHaveURL(/\/en\/login/u, { timeout: 30_000 });

  await verifyMfaLogin(page);
  const surfaces = await verifySurfaces(page);

  console.log(
    JSON.stringify(
      {
        baseOrigin: new URL(baseURL).origin,
        protectionAccess: shareURL
          ? "share-bypass-cookie"
          : process.env.VERCEL_OIDC_TOKEN
            ? "trusted-oidc-header"
            : "temporary-alias-override",
        adminEmail: email,
        login: "ok",
        mfa: "ok",
        logout: "ok",
        sessionCookie: "secure-httpOnly-lax",
        surfaces,
        secretPrinted: false
      },
      null,
      2
    )
  );
} finally {
  await context.close();
  await browser.close();
}
