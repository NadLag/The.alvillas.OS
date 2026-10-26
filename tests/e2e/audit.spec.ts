import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import AxeBuilder from "@axe-core/playwright";
import { maskedValue } from "@/platform/authz/present";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { hashPassword } from "@/platform/auth/password";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function login(page: Page, email: string, password = adminPassword) {
  await page.goto("/en/login");
  await waitForE2EAdminLoginWindow(page, email);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await completeE2EAdminMfa(page, email);
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
  permissionKeys?: string[];
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
      let role = await repository.findRoleByKey(input.roleKey);
      if (!role && input.permissionKeys) {
        role = await tx.role.create({ data: { organizationId: bootstrapOrganizationId, key: input.roleKey, name: "Dedicated audit-only reader" } });
        const permissions = await tx.permission.findMany({ where: { organizationId: bootstrapOrganizationId, key: { in: input.permissionKeys } } });
        expect(permissions).toHaveLength(input.permissionKeys.length);
        await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: bootstrapOrganizationId, roleId: role!.id, permissionId: permission.id })) });
      }
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
  const occurredAt = new Date();

  try {
    return await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) => {
      const property = await tx.property.create({ data: { organizationId: bootstrapOrganizationId,
        name: `Dedicated audit villa ${label}`, addressLine1: "Local audit fixture", city: "Marrakech",
        propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
      const finance = new FinanceRepository(tx, bootstrapOrganizationId);
      const bank = await finance.ensureLedgerAccount({ code: "BANK_AUDIT_E2E", name: "Dedicated audit bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
      const claim = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Owner payable", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
      const journal = await finance.createFinancialTransaction({ reference: `Dedicated audit ${label}`, description: "Dedicated immutable audit source",
        occurredAt, createdBy: actorId, idempotencyKey: randomUUID(), postings: [
          { ledgerAccountId: bank.id, side: "DEBIT", amount: Money.of("8000", "MAD"), bucket: "OWNER_REVENUE", dimensions: { property_id: property.id } },
          { ledgerAccountId: claim.id, side: "CREDIT", amount: Money.of("8000", "MAD"), bucket: "OWNER_REVENUE", dimensions: { property_id: property.id } }
        ] });
      await writeAuditEvent(tx, {
        organizationId: bootstrapOrganizationId,
        actorId,
        action: `reservation.revenue.posted.${label}`,
        resourceType: "financial_transaction",
        resourceId: journal.id,
        ipAddress: "127.0.0.1",
        deviceId: "e2e-audit-device",
        propertyScopeId: property.id,
        before: {
          status: "draft",
          email: "guest@example.test"
        },
        after: {
          status: "posted",
          grossAmount: { amount: "8000.00", currency: "MAD" },
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
      return journal.id;
    });
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
    expect(csv).toContain("8000.00");
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

  for (const locale of ["en", "fr", "ar"]) {
    test(`financial payloads stay private for an authenticated audit-only reader ${locale}`, async ({ page }, testInfo) => {
      test.setTimeout(120000);
      const label = `audit-private-${locale}-${Date.now()}-${testInfo.project.name}`;
      const email = e2eEmail(label, testInfo.project.name);
      const password = "dedicated local audit privacy fixture";
      await ensureE2EUserWithRole({ email, password, roleKey: `audit_private_${randomUUID()}`, permissionKeys: ["audit_log:view", "audit_log:export"] });
      const resourceId = await seedAuditEvents(await userAccountId(email), label);
      await login(page, email, password);
      await page.goto(`/${locale}/app/audit?resourceId=${resourceId}`);
      const row = page.getByTestId("audit-row").filter({ hasText: `reservation.revenue.posted.${label}` });
      await expect(row).toBeVisible();
      await row.locator("summary").click();
      await expect(row.locator("pre")).toHaveText([JSON.stringify(maskedValue, null, 2), JSON.stringify(maskedValue, null, 2)]);
      await expect(row).not.toContainText("8000.00");
      await expect(row).not.toContainText("E2E audit fixture");
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("audit-export-link").click();
      const download = await downloadPromise;
      const path = await download.path();
      expect(path).toBeTruthy();
      const csv = readFileSync(path, "utf8");
      expect(csv).toContain(`reservation.revenue.posted.${label}`);
      expect(csv).toContain(maskedValue);
      expect(csv).not.toContain("8000.00");
      expect(csv).not.toContain("E2E audit fixture");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }
});
