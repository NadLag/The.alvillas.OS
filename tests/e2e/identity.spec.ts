import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";
import { totpCode } from "@/platform/auth/totp";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);
const passkeyOrigin = "http://localhost:3000";

async function loginAdmin(page: Page, email: string, origin = "") {
  await page.goto(`${origin}/en/login`);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u);
}

function invitationHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

test.describe("identity lifecycle", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for identity E2E");
  test.describe.configure({ mode: "serial" });

  test("invites, activates, denies invitation reuse, and suspends a field user", async ({ page }, testInfo) => {
    const adminEmail = e2eEmail("identity-admin", testInfo.project.name);
    const invitedEmail = e2eEmail(`identity-field-${Date.now()}`, testInfo.project.name);
    const invitedPhone = `+212600${Date.now().toString().slice(-6)}`.toLowerCase();
    await ensureE2EAdmin(adminEmail, adminPassword);
    await loginAdmin(page, adminEmail);

    await page.goto("/en/app/identity");
    await page.getByTestId("invite-display-name").fill("Identity Field User");
    await page.getByTestId("invite-email").fill(invitedEmail);
    await page.getByTestId("invite-phone").fill(invitedPhone);
    await page.getByTestId("invite-role").selectOption("field_staff");
    await page.getByTestId("invite-submit").click();

    const codeText = await page.getByTestId("invitation-code").innerText();
    const code = codeText.split(":").pop()?.trim();
    expect(code).toBeTruthy();

    await page.goto(`/en/activate/${code}`);
    await page.getByTestId("activation-phone").fill(invitedPhone);
    await page.getByTestId("activation-pin").fill("123456");
    await page.getByTestId("activation-password").fill("correct horse field staple");
    await page.getByTestId("activation-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.context().clearCookies();
    await page.goto("/en/login");
    await page.getByTestId("login-phone").fill(invitedPhone);
    await page.getByTestId("login-pin").fill("123456");
    await page.getByRole("radio", { name: "PIN" }).check();
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.goto(`/en/activate/${code}`);
    await page.getByTestId("activation-phone").fill(invitedPhone);
    await page.getByTestId("activation-pin").fill("123456");
    await page.getByTestId("activation-submit").click();
    await expect(page.getByTestId("identity-form-error")).toContainText(/expired|already used|does not match/i);

    await page.context().clearCookies();
    await loginAdmin(page, adminEmail);
    await page.goto("/en/app/identity");
    await page
      .getByTestId("identity-account-row")
      .filter({ hasText: invitedEmail })
      .getByTestId("suspend-account-button")
      .click();
    await expect(page.getByTestId("identity-account-row").filter({ hasText: invitedEmail })).toContainText("SUSPENDED");

    await page.context().clearCookies();
    await page.goto("/en/login");
    await page.getByTestId("login-phone").fill(invitedPhone);
    await page.getByTestId("login-pin").fill("123456");
    await page.getByRole("radio", { name: "PIN" }).check();
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();

    await page.context().clearCookies();
    await loginAdmin(page, adminEmail);
    await page.goto("/en/app/identity");
    const recoveredRow = page.getByTestId("identity-account-row").filter({ hasText: invitedEmail });
    await recoveredRow.getByTestId("issue-recovery-button").click();
    const recoveryText = await recoveredRow.getByTestId("recovery-code").innerText();
    const recoveryCode = recoveryText.split(":").pop()?.trim() ?? "";
    expect(recoveryCode).toBeTruthy();

    await page.context().clearCookies();
    await page.goto("/en/recover");
    await page.getByTestId("recovery-email").fill(invitedEmail);
    await page.getByTestId("recovery-code-input").fill(recoveryCode);
    await page.getByTestId("recovery-password").fill("correct horse recovered staple");
    await page.getByTestId("recovery-submit").click();
    await expect(page).toHaveURL(/\/en\/login/u);
    await page.getByTestId("login-email").fill(invitedEmail);
    await page.getByTestId("login-password").fill("correct horse recovered staple");
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);
  });

  test("denies expired invitations and supports MFA plus passkey registration", async ({ page }, testInfo) => {
    const adminEmail = e2eEmail(`identity-security-${Date.now()}-${testInfo.retry}`, testInfo.project.name);
    const invitedEmail = e2eEmail(`identity-expired-${Date.now()}`, testInfo.project.name);
    const invitedPhone = `+212601${Date.now().toString().slice(-6)}`.toLowerCase();
    await ensureE2EAdmin(adminEmail, adminPassword);
    await loginAdmin(page, adminEmail, passkeyOrigin);

    await page.goto(`${passkeyOrigin}/en/app/identity`);
    await page.getByTestId("invite-display-name").fill("Expired Invite User");
    await page.getByTestId("invite-email").fill(invitedEmail);
    await page.getByTestId("invite-phone").fill(invitedPhone);
    await page.getByTestId("invite-role").selectOption("field_staff");
    await page.getByTestId("invite-submit").click();
    const codeText = await page.getByTestId("invitation-code").innerText();
    const code = codeText.split(":").pop()?.trim() ?? "";

    const prisma = new PrismaClient();
    await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
      await tx.invitation.update({
        where: {
          organizationId_codeHash: {
            organizationId: bootstrapOrganizationId,
            codeHash: invitationHash(code)
          }
        },
        data: {
          expiresAt: new Date(Date.now() - 60_000)
        }
      });
    });
    await prisma.$disconnect();

    await page.goto(`${passkeyOrigin}/en/activate/${code}`);
    await page.getByTestId("activation-phone").fill(invitedPhone);
    await page.getByTestId("activation-pin").fill("654321");
    await page.getByTestId("activation-submit").click();
    await expect(page.getByTestId("identity-form-error")).toContainText(/expired|already used|does not match/i);

    await page.context().clearCookies();
    await loginAdmin(page, adminEmail, passkeyOrigin);
    await page.goto(`${passkeyOrigin}/en/app/identity`);
    await page.getByTestId("start-totp-button").click();
    const secretText = await page.getByTestId("totp-secret").innerText();
    const secret = secretText.split(":").pop()?.trim() ?? "";
    await page.getByTestId("totp-code").fill(totpCode(secret));
    await page.getByTestId("confirm-totp-button").click();
    await expect(page.getByTestId("mfa-recovery-code").first()).toBeVisible();

    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true
      }
    });

    await page.getByTestId("register-passkey-button").click();
    await expect(page.getByText("Passkey registered.")).toBeVisible();
  });
});
