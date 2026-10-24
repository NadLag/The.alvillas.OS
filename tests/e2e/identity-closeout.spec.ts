import { expect, test, type Page } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { totpCode } from "@/platform/auth/totp";
import { PrismaClient } from "@prisma/client";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import AxeBuilder from "@axe-core/playwright";

const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const origin = "http://localhost:3000";
async function session(page: Page) {
  const payload = await (await page.request.get(`${origin}/api/auth/session`)).json() as { user?: { id?: string } } | null;
  return payload ?? {};
}

async function login(page: Page, email: string, accountPassword = password) {
  await page.goto(`${origin}/en/login`);
  await waitForE2EAdminLoginWindow(page, email);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(accountPassword);
  await page.getByTestId("login-submit").click();
  await completeE2EAdminMfa(page, email);
  await expect(page).toHaveURL(/\/en\/app/u);
}

async function invite(page: Page, email: string, phone: string, role: string) {
  await page.goto(`${origin}/en/app/identity`);
  await page.getByTestId("invite-display-name").fill(email);
  await page.getByTestId("invite-email").fill(email);
  await page.getByTestId("invite-phone").fill(phone);
  await page.getByTestId("invite-role").selectOption(role);
  await page.getByTestId("invite-submit").click();
  const code = (await page.getByTestId("invitation-code").innerText()).split(":").pop()?.trim();
  if (!code) throw new Error("Expected a real invitation");
  return code;
}

async function activate(page: Page, code: string, phone: string) {
  await page.goto(`${origin}/en/activate/${code}`);
  await page.getByTestId("activation-phone").fill(phone);
  await page.getByTestId("activation-pin").fill("654321");
  await page.getByTestId("activation-password").fill(password);
  await page.getByTestId("activation-submit").click();
  await expect(page).toHaveURL(/\/en\/login/u);
  await page.locator('input[name="method"][value="pin"]').check();
  await page.getByTestId("login-phone").fill(phone);
  await page.getByTestId("login-pin").fill("654321");
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u);
}

test.describe("identity closeout acceptance", () => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required");

  test("invitation activation and sign-in use the recipient's selected language", async ({ page }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const adminEmail = e2eEmail(`localized-invite-admin-${suffix}`, testInfo.project.name);
    const email = e2eEmail(`localized-invite-${suffix}`, testInfo.project.name);
    const phone = `+21264${Date.now().toString().slice(-7)}`;
    await ensureE2EAdmin(adminEmail, password);
    await login(page, adminEmail);
    await page.goto(`${origin}/en/app/identity`);
    await page.getByTestId("invite-display-name").fill("French recipient");
    await page.getByTestId("invite-email").fill(email);
    await page.getByTestId("invite-phone").fill(phone);
    await page.getByTestId("invite-role").selectOption("field_staff");
    await page.getByTestId("invite-preferred-locale").selectOption("fr");
    await page.getByTestId("invite-submit").click();
    const code = (await page.getByTestId("invitation-code").innerText()).split(":").pop()?.trim();
    expect(code).toBeTruthy();
    const profile = page.getByTestId("person-profile-row").filter({ hasText: email });
    await profile.locator("summary").click();
    await expect(profile.locator('[name="preferredLocale"]')).toHaveValue("fr");
    await page.context().clearCookies();
    await page.goto(`${origin}/fr/activate/${code}`);
    await page.getByTestId("activation-phone").fill(phone);
    await page.getByTestId("activation-pin").fill("654321");
    await page.getByTestId("activation-password").fill(password);
    await page.getByTestId("activation-submit").click();
    await expect(page).toHaveURL(/\/fr\/login/u);
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/fr\/app/u);
    expect((await session(page)).user?.id).toBeTruthy();
  });


  test("finance invitation restricts access until real passkey and authenticator enrollment", async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const adminEmail = e2eEmail(`finance-enrollment-admin-${suffix}`, testInfo.project.name);
    const email = e2eEmail(`finance-enrollment-${suffix}`, testInfo.project.name);
    const phone = `+21265${Date.now().toString().slice(-7)}`;
    await ensureE2EAdmin(adminEmail, password);
    await login(page, adminEmail);
    const code = await invite(page, email, phone, "finance");
    await page.context().clearCookies();
    await page.goto(`${origin}/en/activate/${code}`);
    await page.getByTestId("activation-phone").fill(phone);
    await page.getByTestId("activation-pin").fill("654321");
    await page.getByTestId("activation-password").fill(password);
    await page.getByTestId("activation-submit").click();
    await expect(page).toHaveURL(/\/en\/login/u);
    await page.locator('input[name="method"][value="pin"]').check();
    await page.getByTestId("login-phone").fill(phone);
    await page.getByTestId("login-pin").fill("654321");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
    expect((await session(page)).user?.id).toBeFalsy();
    await page.goto(`${origin}/en/login`);
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app\/security/u);
    await page.goto(`${origin}/en/app/identity`);
    await expect(page).toHaveURL(/\/en\/app\/security/u);
    await page.goto(`${origin}/en/app/field`); await expect(page).toHaveURL(/\/en\/app\/security/u);
    await page.goto(`${origin}/en/app/field/018f0a0b-0000-7000-9000-000000000901`); await expect(page).toHaveURL(/\/en\/app\/security/u);
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true
    } });
    await page.getByTestId("register-passkey-button").click();
    await expect(page.getByText("Passkey registered.", { exact: true })).toBeVisible();
    await page.getByTestId("start-totp-button").click();
    const secret = (await page.getByTestId("totp-secret").innerText()).split(":").pop()?.trim() ?? "";
    await page.getByTestId("totp-code").fill(totpCode(secret));
    await page.getByTestId("confirm-totp-button").click();
    await expect(page.getByTestId("mfa-recovery-code")).toHaveCount(8);
    expect((await session(page)).user?.id).toBeFalsy();
    await page.context().clearCookies();
    await page.goto(`${origin}/en/login`);
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-passkey").click();
    await expect(page.getByTestId("login-mfa-step")).toBeVisible();
    await page.getByTestId("login-mfa-code").fill(totpCode(secret));
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const authenticated = await (await page.request.get(`${origin}/api/auth/session`)).json() as { user?: { securitySetupRequired?: boolean } } | null;
    expect(authenticated?.user?.securitySetupRequired).toBe(false);
  });

  test("owner passkey sign-in creates a real session and optional MFA cannot be bypassed with PIN", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const adminEmail = e2eEmail(`owner-security-admin-${suffix}`, testInfo.project.name);
    const ownerEmail = e2eEmail(`owner-security-${suffix}`, testInfo.project.name);
    const phone = `+21262${Date.now().toString().slice(-7)}`;
    await ensureE2EAdmin(adminEmail, password);
    await login(page, adminEmail);
    const code = await invite(page, ownerEmail, phone, "owner");
    await page.context().clearCookies();
    await activate(page, code, phone);
    await page.goto(`${origin}/en/app/security`);
    await expect(page.getByTestId("account-security-page")).toBeVisible();
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true
    } });
    await page.getByTestId("register-passkey-button").click();
    await expect(page.getByText("Passkey registered.")).toBeVisible();
    await page.context().clearCookies();
    await page.goto(`${origin}/fr/login`);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByTestId("login-email").fill(ownerEmail);
    await page.getByTestId("login-passkey").click();
    await expect(page).toHaveURL(/\/en\/app/u);
    const ownerSession = await session(page);
    expect(ownerSession.user?.id).toBeTruthy();
    await page.goto(`${origin}/en/app/security`);
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`${origin}/${locale}/app/security`);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goto(`${origin}/en/app/security`);
    await page.getByTestId("start-totp-button").click();
    const secret = (await page.getByTestId("totp-secret").innerText()).split(":").pop()?.trim() ?? "";
    await page.getByTestId("totp-code").fill(totpCode(secret));
    await page.getByTestId("confirm-totp-button").click();
    await expect(page.getByTestId("mfa-recovery-code")).toHaveCount(8);
    await page.context().clearCookies();
    await page.goto(`${origin}/en/login`);
    await page.locator('input[name="method"][value="pin"]').check();
    await page.getByTestId("login-phone").fill(phone);
    await page.getByTestId("login-pin").fill("654321");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
    expect((await session(page)).user?.id).toBeFalsy();
    await page.goto(`${origin}/en/login`);
    await page.getByTestId("login-email").fill(ownerEmail);
    await page.getByTestId("login-passkey").click();
    await expect(page.getByTestId("login-mfa-step")).toBeVisible();
    await page.getByTestId("login-mfa-code").fill(totpCode(secret));
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);
    expect((await session(page)).user?.id).toBe(ownerSession.user?.id);
  });

  test("person profiles and account suspension, remote revocation, PIN reset and offboarding work through authenticated UI", async ({ page, browser }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const adminEmail = e2eEmail(`lifecycle-admin-${suffix}`, testInfo.project.name);
    const targetEmail = e2eEmail(`lifecycle-target-${suffix}`, testInfo.project.name);
    const phone = `+21263${Date.now().toString().slice(-7)}`;
    await ensureE2EAdmin(adminEmail, password);
    await login(page, adminEmail);
    await page.goto(`${origin}/en/app/identity`);
    const personName = `Profile without account ${suffix}`;
    await page.getByTestId("person-display-name").fill(personName);
    await page.getByTestId("person-phone").fill(phone);
    // Notification polling also posts here; identify this form submission.
    const created = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      Boolean(response.request().postData()?.includes(phone.slice(1))) &&
      new URL(response.url()).pathname === "/en/app/identity"
    );
    await page.getByTestId("person-create-submit").click();
    const creationResponse = await created;
    expect(creationResponse.status()).toBe(200);
    // The refreshed page can keep streaming after the command has committed.
    await expect(page.getByTestId("person-create-submit")).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("person-create-form").getByRole("status")).toHaveText("Person profile created.");
    const person = page.getByTestId("person-profile-row").filter({ hasText: personName });
    await expect(person).toBeVisible();
    const profileDb = new PrismaClient();
    try {
      const createdProfiles = await withTenant(profileDb, bootstrapOrganizationId, tx => tx.person.findMany({
        where: { organizationId: bootstrapOrganizationId, displayName: personName, phone },
        select: { email: true, phone: true, preferredLocale: true, userAccounts: { select: { id: true } } }
      }));
      expect(createdProfiles).toHaveLength(1);
      expect(createdProfiles[0]).toEqual({ email: null, phone, preferredLocale: "en", userAccounts: [] });
    } finally { await profileDb.$disconnect(); }
    await person.locator("summary").click();
    await person.getByTestId("edit-person-display-name").fill(`${personName} edited`);
    await person.getByTestId("person-edit-submit").click();
    await expect(person).toContainText("edited");
    const code = await invite(page, targetEmail, phone, "field_staff");
    const targetContext = await browser.newContext();
    try {
      const target = await targetContext.newPage();
      await activate(target, code, phone);
      const device = (await targetContext.cookies()).find((cookie) => cookie.name === "alvillas_device_id")?.value;
      expect(device).toBeTruthy();
      await page.reload();
      const account = page.getByTestId("identity-account-row").filter({ hasText: targetEmail });
      // Credentials and sessions also display ACTIVE; wait for the account's own status.
      const accountStatus = account.locator(":scope > span").filter({ has: page.getByText("Status", { exact: true }) }).locator("strong");
      await account.getByTestId("revoke-session-button").first().click();
      await expect(account.getByTestId("identity-session-row").first()).toContainText("REVOKED");
      await target.goto(`${origin}/en/app`);
      await expect(target).toHaveURL(/\/en\/login/u);
      await login(target, targetEmail);
      expect((await targetContext.cookies()).find((cookie) => cookie.name === "alvillas_device_id")?.value).toBe(device);
      await page.reload();
      await account.getByTestId("revoke-device-button").first().click();
      await expect(account.getByTestId("identity-device-row").first()).toContainText("REVOKED");
      await target.goto(`${origin}/en/app`);
      await expect(target).toHaveURL(/\/en\/login/u);
      await account.getByTestId("reset-pin-input").fill("987654");
      await account.getByTestId("reset-pin-button").click();
      await expect(account.locator(".pin-reset-form")).toContainText("PIN reset");
      await target.goto(`${origin}/en/login`);
      await target.locator('input[name="method"][value="pin"]').check();
      await target.getByTestId("login-phone").fill(phone);
      await target.getByTestId("login-pin").fill("987654");
      await target.getByTestId("login-submit").click();
      await expect(target).toHaveURL(/\/en\/app/u);
      await page.reload();
      await account.getByTestId("suspend-account-button").click();
      await expect(accountStatus).toHaveText("SUSPENDED");
      await target.goto(`${origin}/en/app`);
      await expect(target).toHaveURL(/\/en\/login/u);
      await account.getByTestId("reactivate-account-button").click();
      await expect(accountStatus).toHaveText("ACTIVE");
      await login(target, targetEmail);
      await page.reload();
      const passwordCredential = account.getByTestId("identity-credential-row").filter({ hasText: "Password" }).first();
      await passwordCredential.getByTestId("revoke-credential-button").click();
      await expect(passwordCredential).toContainText("REVOKED");
      await target.goto(`${origin}/en/app`);
      await expect(target).toHaveURL(/\/en\/login/u);
      await target.getByTestId("login-email").fill(targetEmail);
      await target.getByTestId("login-password").fill(password);
      await target.getByTestId("login-submit").click();
      await expect(target.getByTestId("login-error")).toBeVisible();
      await account.getByTestId("deactivate-account-button").click();
      await expect(accountStatus).toHaveText("DEACTIVATED");
      expect((await session(target)).user?.id).toBeFalsy();
    } finally { await targetContext.close(); }
  });

  test("phone-only invitation uses persisted PIN backoff across IPs and permits login after the configured delay", async ({ page, browser }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const adminEmail = e2eEmail(`pin-backoff-admin-${suffix}`, testInfo.project.name);
    const phone = `+21264${Date.now().toString().slice(-7)}`;
    await ensureE2EAdmin(adminEmail, password);
    await login(page, adminEmail);
    // Only timing configuration is a local PostgreSQL fixture; identities and all
    // authentication use the invitation, activation and Auth.js browser paths.
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1", "::1"].includes(database.hostname)) throw new Error("A local test database is required");
    const prisma = new PrismaClient();
    try {
      await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, (tx) =>
        new ConfigRuleRepository(tx, bootstrapOrganizationId).createVersion({
          key: "identity.pin_lockout", scopeType: "organization", effectiveFrom: new Date(),
          value: { attempts: 2, initialDelaySeconds: 10, maximumDelaySeconds: 40, resetAfterSeconds: 60 },
          reason: "Local browser PIN backoff acceptance"
        }));
    } finally { await prisma.$disconnect(); }
    await page.goto(`${origin}/en/app/identity`);
    await page.getByTestId("invite-display-name").fill(`Phone-only staff ${suffix}`);
    await page.getByTestId("invite-phone").fill(phone);
    await page.getByTestId("invite-role").selectOption("field_staff");
    await page.getByTestId("invite-submit").click();
    const code = (await page.getByTestId("invitation-code").innerText()).split(":").pop()?.trim() ?? "";
    const staffContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.10" } });
    const anotherIpContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.11" } });
    try {
      const staff = await staffContext.newPage();
      await staff.goto(`${origin}/en/activate/${code}`);
      await staff.getByTestId("activation-phone").fill(phone);
      await staff.getByTestId("activation-pin").fill("654321");
      await staff.getByTestId("activation-submit").click();
      await expect(staff).toHaveURL(/\/en\/login/u);
      for (let attempt = 0; attempt < 2; attempt++) {
        await staff.goto(`${origin}/en/login`);
        await staff.locator('input[name="method"][value="pin"]').check();
        await staff.getByTestId("login-phone").fill(phone);
        await staff.getByTestId("login-pin").fill("111111");
        await staff.getByTestId("login-submit").click();
        await expect(staff.getByTestId("login-error")).toBeVisible();
        await expect(staff.locator('input[name="method"][value="pin"]')).toBeChecked();
        await expect(staff.getByTestId("login-submit")).toBeEnabled();
      }
      const anotherIp = await anotherIpContext.newPage();
      await anotherIp.goto(`${origin}/en/login`);
      await anotherIp.locator('input[name="method"][value="pin"]').check();
      await anotherIp.getByTestId("login-phone").fill(phone);
      await anotherIp.getByTestId("login-pin").fill("654321");
      await anotherIp.getByTestId("login-submit").click();
      await expect(anotherIp.getByTestId("login-error")).toBeVisible();
      await expect(anotherIp.locator('input[name="method"][value="pin"]')).toBeChecked();
      expect((await session(anotherIp)).user?.id).toBeFalsy();
      await anotherIp.waitForTimeout(10_100); // The configured real lock expiry is part of this security journey.
      await anotherIp.getByTestId("login-phone").fill(phone);
      await anotherIp.getByTestId("login-pin").fill("654321");
      await anotherIp.getByTestId("login-submit").click();
      await expect(anotherIp).toHaveURL(/\/en\/app/u);
      expect((await session(anotherIp)).user?.id).toBeTruthy();
    } finally { await staffContext.close(); await anotherIpContext.close(); }
  });
});
