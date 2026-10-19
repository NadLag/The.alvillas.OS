import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import { totpCode } from "@/platform/auth/totp";
import { randomUUID } from "node:crypto";

const enrolledAuthenticators = new Map<string, string>();
const expect=playwrightExpect.configure({timeout:30000});
const loginAttempts = new Map<string, { epoch: number; count: number }>();
const workerAccountNamespace = randomUUID().slice(0, 8);

export async function waitForE2EAdminLoginWindow(page: Page, email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const epoch = Math.floor(Date.now() / 60000);
  const previous = loginAttempts.get(normalizedEmail);
  if (!previous || previous.epoch !== epoch) { loginAttempts.set(normalizedEmail, { epoch, count: 0 }); return; }
  if (previous.count + 2 <= 5) return;
  // Real logins consume both primary and MFA attempts. Obey the actual window;
  // never clear buckets, relax the limiter or skip authentication in tests.
  await page.waitForTimeout(60000 - Date.now() % 60000 + 100);
  loginAttempts.set(normalizedEmail, { epoch: Math.floor(Date.now() / 60000), count: 0 });
}

export async function completeE2EAdminMfa(page: Page, email: string): Promise<void> {
  const secret = enrolledAuthenticators.get(email.trim().toLowerCase());
  if (!secret) return;
  await expect(page.getByTestId("login-mfa-step")).toBeVisible();
  await page.getByTestId("login-mfa-code").fill(totpCode(secret));
  await page.getByTestId("login-submit").click();
  const epoch = Math.floor(Date.now() / 60000);
  const previous = loginAttempts.get(email.trim().toLowerCase());
  loginAttempts.set(email.trim().toLowerCase(), { epoch, count: (previous?.epoch === epoch ? previous.count : 0) + 2 });
}

export async function enrollE2EAccountSecurity(email: string, password: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  if (enrolledAuthenticators.has(normalizedEmail)) return;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto("http://localhost:3000/en/login");
    await page.getByTestId("login-email").fill(normalizedEmail);
    await page.getByTestId("login-password").fill(password);
    const primaryEpoch = Math.floor(Date.now() / 60000);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app\/security/u);
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    await client.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true
    } });
    await page.getByTestId("register-passkey-button").click();
    await expect(page.getByText("Passkey registered.", { exact: true })).toBeVisible();
    await page.getByTestId("start-totp-button").click();
    const secret = (await page.getByTestId("totp-secret").innerText()).split(":").pop()?.trim();
    if (!secret) throw new Error("Expected authenticator enrollment through the real security panel");
    await page.getByTestId("totp-code").fill(totpCode(secret));
    await page.getByTestId("confirm-totp-button").click();
    await expect(page.getByTestId("mfa-recovery-code")).toHaveCount(8);
    const session = await (await page.request.get("http://localhost:3000/api/auth/session")).json() as { user?: { id?: string } } | null;
    expect(session?.user?.id).toBeFalsy();
    enrolledAuthenticators.set(normalizedEmail, secret);
    loginAttempts.set(normalizedEmail, { epoch: primaryEpoch, count: 1 });
  } finally { await browser.close(); }
}

export function e2eEmail(label: string, projectName: string): string {
  return `e2e-${label}-${projectName}-${workerAccountNamespace}@example.test`
    .toLowerCase()
    .replace(/[^a-z0-9@.-]+/gu, "-");
}

export async function ensureE2EAdmin(email: string, password: string): Promise<void> {
  const prisma = new PrismaClient();
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  try {
    await prisma.organization.upsert({
      where: { id: bootstrapOrganizationId },
      update: { name: "ALVILLAS SARL", baseCurrency: "MAD" },
      create: { id: bootstrapOrganizationId, name: "ALVILLAS SARL", baseCurrency: "MAD" }
    });

    await ensureStandardIdentitySetup(bootstrapOrganizationId, {
      db: prisma as unknown as TenantTransactionRunner
    });

    await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
      const person = await tx.person.upsert({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: normalizedEmail
          }
        },
        update: {
          displayName: "ALVILLAS E2E Admin",
          preferredLocale: "en"
        },
        create: {
          organizationId: bootstrapOrganizationId,
          displayName: "ALVILLAS E2E Admin",
          email: normalizedEmail,
          preferredLocale: "en"
        }
      });

      await tx.userAccount.upsert({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: normalizedEmail
          }
        },
        update: {
          personId: person.id,
          passwordHash,
          status: "ACTIVE"
        },
        create: {
          organizationId: bootstrapOrganizationId,
          personId: person.id,
          email: normalizedEmail,
          passwordHash,
          status: "ACTIVE"
        }
      });

      const account = await tx.userAccount.findUniqueOrThrow({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: normalizedEmail
          }
        }
      });
      const existingPasswordCredential = await tx.authCredential.findFirst({
        where: {
          organizationId: bootstrapOrganizationId,
          userAccountId: account.id,
          type: "PASSWORD",
          revokedAt: null
        }
      });

      if (existingPasswordCredential) {
        await tx.authCredential.update({
          where: { id: existingPasswordCredential.id },
          data: { secretHash: passwordHash }
        });
      } else {
        await tx.authCredential.create({
          data: {
            organizationId: bootstrapOrganizationId,
            userAccountId: account.id,
            type: "PASSWORD",
            label: "Password",
            secretHash: passwordHash
          }
        });
      }

      const repository = new IdentityRepository(tx, bootstrapOrganizationId);

      const adminRole = await repository.findRoleByKey("admin");

      if (adminRole) {
        await repository.assignRole({
          personId: person.id,
          userAccountId: account.id,
          roleId: adminRole.id,
          scopeType: "organization",
          actorId: account.id
        });
      }
    });
  } finally {
    await prisma.$disconnect();
  }
  await enrollE2EAccountSecurity(normalizedEmail, password);
}
