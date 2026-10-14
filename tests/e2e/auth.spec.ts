import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";
import { hashCredentialSecret } from "@/platform/auth/password";
import { encryptSecret } from "@/platform/auth/secret-encryption";
import { generateTotpSecret, totpCode } from "@/platform/auth/totp";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);
let prisma: PrismaClient | undefined;

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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

async function requireTotpForAccount(email: string): Promise<string> {
  const client = new PrismaClient();
  const secret = generateTotpSecret();

  try {
    await withTenant(client as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
      const account = await tx.userAccount.findFirstOrThrow({
        where: {
          organizationId: bootstrapOrganizationId,
          email: email.trim().toLowerCase()
        },
        select: { id: true }
      });

      await tx.userAccount.update({
        where: { id: account.id },
        data: { mfaRequired: true }
      });
      await tx.authCredential.updateMany({
        where: {
          organizationId: bootstrapOrganizationId,
          userAccountId: account.id,
          type: { in: ["TOTP", "RECOVERY_CODE"] },
          revokedAt: null
        },
        data: { revokedAt: new Date() }
      });
      await tx.authCredential.create({
        data: {
          organizationId: bootstrapOrganizationId,
          userAccountId: account.id,
          type: "TOTP",
          label: "Authenticator app",
          secretEncrypted: encryptSecret(secret)
        }
      });
      await tx.authCredential.create({
        data: {
          organizationId: bootstrapOrganizationId,
          userAccountId: account.id,
          type: "RECOVERY_CODE",
          label: "MFA recovery code",
          secretHash: await hashCredentialSecret("RECOVERY-CODE-123456")
        }
      });
    });
  } finally {
    await client.$disconnect();
  }

  return secret;
}

test("switches login between English, French and Arabic-ready RTL", async ({ page }) => {
  await page.goto("/en/login");

  await expect(page.getByRole("heading", { name: "Sign in to ALVILLAS OS" })).toBeVisible();
  await expect(page.getByTestId("login-email")).toBeVisible();
  await expect(page.getByTestId("login-mfa-code")).toHaveCount(0);
  await expect(page.getByTestId("login-recovery-code")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.getByRole("link", { name: "Francais" }).click();

  await expect(page).toHaveURL(/\/fr\/login/u);
  await expect(page.getByRole("heading", { name: "Connexion a ALVILLAS OS" })).toBeVisible();

  await page.getByTestId("locale-switch-ar").click();

  await expect(page).toHaveURL(/\/ar\/login/u);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("locale-switch-ar")).toHaveAttribute("aria-current", "page");

  const switchBox = await visibleBox(page.getByTestId("locale-switch"));
  const panelBox = await visibleBox(page.locator(".auth-panel"));
  expect(boxesOverlap(switchBox, panelBox)).toBe(false);

  await page.getByRole("link", { name: "English" }).click();

  await expect(page).toHaveURL(/\/en\/login/u);
  await expect(page.getByRole("heading", { name: "Sign in to ALVILLAS OS" })).toBeVisible();
});

test("public landing exposes a clear sign in path and login fits 360px", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByTestId("home-sign-in")).toBeVisible();
  await page.getByTestId("home-sign-in").click();
  await expect(page).toHaveURL(/\/en\/login/u);

  await page.setViewportSize({ width: 360, height: 760 });
  await expect(page.getByTestId("login-email")).toBeVisible();
  await page.getByTestId("login-email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-password")).toBeFocused();

  const panelBox = await visibleBox(page.locator(".auth-panel"));
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.width).toBeLessThanOrEqual(360);
});

test.describe("admin authentication", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for auth E2E");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    prisma = new PrismaClient();
  });

  test.beforeEach(async () => {
    await prisma?.$executeRawUnsafe("DELETE FROM rate_limit_bucket");
  });

  test.afterEach(async () => {
    await prisma?.$executeRawUnsafe("DELETE FROM rate_limit_bucket");
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/en/app");

    await expect(page).toHaveURL(/\/en\/login/u);
  });

  test("logs in and logs out the bootstrap admin", async ({ page }, testInfo) => {
    const loginEmail = e2eEmail("auth-login", testInfo.project.name);
    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/en\/app/u);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("logout-button").click();

    await expect(page).toHaveURL(/\/en\/login/u);
  });

  test("shows MFA only after primary authentication and accepts authenticator codes", async ({ page }, testInfo) => {
    const loginEmail = e2eEmail(`auth-mfa-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(loginEmail, adminPassword);
    const secret = await requireTotpForAccount(loginEmail);

    await page.goto("/en/login");
    await expect(page.getByTestId("login-mfa-code")).toHaveCount(0);
    await expect(page.getByTestId("login-recovery-code")).toHaveCount(0);
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();

    await expect(page.getByTestId("login-mfa-step")).toBeVisible();
    await expect(page.getByTestId("login-mfa-code")).toBeVisible();
    await expect(page.getByTestId("login-recovery-code")).toHaveCount(0);

    await page.getByTestId("login-use-recovery").click();
    await expect(page.getByTestId("login-recovery-code")).toBeVisible();
    await page.getByTestId("login-use-authenticator").click();
    await page.getByTestId("login-mfa-code").fill("000000");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toContainText(/second factor/i);

    await page.getByTestId("login-mfa-code").fill(totpCode(secret));
    const challengeToken = await page.locator('input[name="mfaChallenge"]').inputValue();
    const deviceId = (await page.context().cookies()).find((cookie) => cookie.name === "alvillas_device_id")?.value;
    expect(deviceId).toBeTruthy();
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/en\/app/u);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.getByTestId("logout-button").click();
    await expect(page).toHaveURL(/\/en\/login/u);
    const csrf = await page.request.get("/api/auth/csrf");
    const csrfBody = await csrf.json() as { csrfToken: string };
    const replay = await page.request.post("/api/auth/callback/credentials", {
      headers: { "X-Auth-Return-Redirect": "1" },
      form: {
        csrfToken: csrfBody.csrfToken, method: "mfa", email: loginEmail,
        mfaChallenge: challengeToken, deviceId: deviceId ?? "", mfaCode: totpCode(secret)
      }
    });
    expect(await replay.text()).toContain("invalid_credentials");
  });

  test("accepts an MFA recovery code once and rejects its reuse", async ({ page }, testInfo) => {
    const loginEmail = e2eEmail(`auth-recovery-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(loginEmail, adminPassword);
    await requireTotpForAccount(loginEmail);
    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-mfa-step")).toBeVisible();
    await page.getByTestId("login-use-recovery").click();
    await page.getByTestId("login-recovery-code").fill("RECOVERY-CODE-123456");
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);
    await page.getByTestId("logout-button").click();
    await expect(page).toHaveURL(/\/en\/login/u);

    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-mfa-step")).toBeVisible();
    await page.getByTestId("login-use-recovery").click();
    await page.getByTestId("login-recovery-code").fill("RECOVERY-CODE-123456");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toContainText(/second factor/i);
  });

  test("saves preferred language and uses it on the workspace", async ({ page }, testInfo) => {
    const loginEmail = e2eEmail(`auth-locale-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/en\/app/u);
    await page.getByTestId("preferred-locale-select").selectOption("fr");
    await page.getByTestId("preferred-locale-submit").click();

    await expect(page).toHaveURL(/\/fr\/app/u);
    await expect(page.getByText("Espace admin")).toBeVisible();

    await page.goto("/en/login");

    await expect(page).toHaveURL(/\/fr\/app/u);
  });

  test("rejects wrong passwords and rate limits repeated attempts", async ({ page }, testInfo) => {
    const rejectedEmail = `blocked-${testInfo.project.name}-${Date.now()}@example.test`
      .toLowerCase()
      .replace(/[^a-z0-9@.-]+/gu, "-");

    await page.goto("/en/login");

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.getByTestId("login-email").fill(rejectedEmail);
      await page.getByTestId("login-password").fill(`wrong-password-${attempt}`);
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().includes("/en/login")
        ),
        page.getByTestId("login-submit").click()
      ]);
      await expect(page.getByTestId("login-submit")).toBeEnabled();
      await expect(page.getByTestId("login-error")).toBeVisible();
    }

    await expect(page.getByTestId("login-error")).toContainText(/Too many attempts/i);
  });

  test("direct Auth.js requests cannot bypass rate limiting with a form flag", async ({ request }, testInfo) => {
    const csrf = await request.get("/api/auth/csrf");
    const body = await csrf.json() as { csrfToken: string };
    const rejectedEmail = e2eEmail(`direct-rate-${Date.now()}`, testInfo.project.name);
    let lastBody = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request.post("/api/auth/callback/credentials", {
        headers: { "X-Auth-Return-Redirect": "1" },
        form: {
          csrfToken: body.csrfToken,
          email: rejectedEmail,
          password: "wrong-password", method: "password", rateLimitChecked: "1"
        }
      });
      lastBody = await response.text();
    }
    expect(lastBody).toContain("rate_limited");
  });
});
