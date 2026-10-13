import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function login(page: Page, email: string, password = adminPassword) {
  await page.goto("/en/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u);
}

async function userAccountId(email: string): Promise<string> {
  const prisma = new PrismaClient();

  try {
    const account = await withTenant(
      prisma as unknown as TenantTransactionRunner,
      bootstrapOrganizationId,
      async (tx) =>
        tx.userAccount.findUniqueOrThrow({
          where: {
            organizationId_email: {
              organizationId: bootstrapOrganizationId,
              email
            }
          },
          select: { id: true }
        })
    );

    return account.id;
  } finally {
    await prisma.$disconnect();
  }
}

async function ensureE2EUserWithRole(input: {
  email: string;
  password: string;
  roleKey: string;
}): Promise<void> {
  const prisma = new PrismaClient();
  const passwordHash = await hashPassword(input.password);

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
            email: input.email
          }
        },
        update: {
          displayName: "ALVILLAS E2E Limited",
          preferredLocale: "en"
        },
        create: {
          organizationId: bootstrapOrganizationId,
          displayName: "ALVILLAS E2E Limited",
          email: input.email,
          preferredLocale: "en"
        }
      });
      const account = await tx.userAccount.upsert({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: input.email
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
          email: input.email,
          passwordHash,
          status: "ACTIVE"
        }
      });
      await tx.authCredential.upsert({
        where: {
          organizationId_type_credentialId: {
            organizationId: bootstrapOrganizationId,
            type: "PASSWORD",
            credentialId: account.id
          }
        },
        update: {
          secretHash: passwordHash,
          revokedAt: null
        },
        create: {
          organizationId: bootstrapOrganizationId,
          userAccountId: account.id,
          type: "PASSWORD",
          label: "Password",
          credentialId: account.id,
          secretHash: passwordHash
        }
      });

      const repository = new IdentityRepository(tx, bootstrapOrganizationId);
      const role = await repository.findRoleByKey(input.roleKey);
      if (!role) {
        throw new Error(`Role was not found: ${input.roleKey}`);
      }

      await repository.assignRole({
        personId: person.id,
        userAccountId: account.id,
        roleId: role.id,
        scopeType: "organization",
        actorId: account.id
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function seedAuditEvents(actorId: string, label: string): Promise<string> {
  const prisma = new PrismaClient();
  const resourceId = randomUUID();
  const occurredAt = new Date();

  try {
    await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
      await writeAuditEvent(tx, {
        organizationId: bootstrapOrganizationId,
        actorId,
        action: `reservation.revenue.posted.${label}`,
        resourceType: "financial_transaction",
        resourceId,
        ipAddress: "127.0.0.1",
        deviceId: "e2e-audit-device",
        propertyScopeId: randomUUID(),
        before: {
          status: "draft",
          email: "guest@example.test"
        },
        after: {
          status: "posted",
          token: "secret-token"
        },
        reason: "E2E audit fixture",
        requestId: `audit-e2e-${label}`,
        occurredAt
      });
      await writeAuditEvent(tx, {
        organizationId: bootstrapOrganizationId,
        actorId,
        action: `identity.account.login.${label}`,
        resourceType: "identity",
        resourceId: actorId,
        ipAddress: "127.0.0.1",
        after: {
          method: "password"
        },
        reason: "E2E login fixture",
        requestId: `audit-e2e-login-${label}`,
        occurredAt
      });
    });

    return resourceId;
  } finally {
    await prisma.$disconnect();
  }
}

test.describe("audit history", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for audit E2E");

  test("admin views, filters, and exports audit history", async ({ page }, testInfo) => {
    const label = `audit-${Date.now()}-${testInfo.project.name}`.toLowerCase().replace(/[^a-z0-9-]+/gu, "-");
    const adminEmail = e2eEmail(`audit-admin-${label}`, testInfo.project.name);
    await ensureE2EAdmin(adminEmail, adminPassword);
    const actorId = await userAccountId(adminEmail);
    const resourceId = await seedAuditEvents(actorId, label);

    await login(page, adminEmail);
    await page.goto("/en/app/audit");
    await expect(page.getByTestId("audit-page")).toBeVisible();
    await expect(page.getByTestId("audit-row").filter({ hasText: `reservation.revenue.posted.${label}` })).toBeVisible();

    await page.getByTestId("audit-filter-action").fill("reservation.revenue");
    await page.getByTestId("audit-filter-resource-id").fill(resourceId);
    await page.getByTestId("audit-filter-submit").click();
    await expect(page).toHaveURL(/action=reservation\.revenue/u);
    await expect(page.getByTestId("audit-row").filter({ hasText: `reservation.revenue.posted.${label}` })).toBeVisible();
    await expect(page.getByTestId("audit-row").filter({ hasText: `identity.account.login.${label}` })).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("audit-export-link").click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();
    const csv = readFileSync(path ?? "", "utf8");

    expect(csv).toContain(`reservation.revenue.posted.${label}`);
    expect(csv).toContain("[REDACTED]");
    expect(csv).not.toContain("secret-token");
    expect(csv).not.toContain("guest@example.test");
  });

  test("denies audit viewer and export to unauthorized users", async ({ page }, testInfo) => {
    const email = e2eEmail(`audit-limited-${Date.now()}`, testInfo.project.name);
    const password = "correct horse limited staple";
    await ensureE2EUserWithRole({ email, password, roleKey: "field_staff" });

    await login(page, email, password);
    await page.goto("/en/app/audit");
    await expect(page.getByTestId("audit-denied")).toBeVisible();
    await expect(page.getByTestId("audit-row")).toHaveCount(0);

    const response = await page.request.get("/api/audit/export");
    expect(response.status()).toBe(403);
  });
});
