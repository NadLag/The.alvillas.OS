import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import {
  e2eEmail,
  ensureE2EAdmin,
  ensureE2EUserWithRole
} from "./support/auth";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function login(page: Page, email: string) {
  await page.goto("/en/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u);
}

async function seedAuditRecords(email: string, label: string) {
  const prisma = new PrismaClient();
  const requestId = `e2e-audit-${label}-${Date.now()}`;

  try {
    return await withTenant(
      prisma as unknown as TenantTransactionRunner,
      bootstrapOrganizationId,
      async (tx) => {
        const account = await tx.userAccount.findUniqueOrThrow({
          where: {
            organizationId_email: {
              organizationId: bootstrapOrganizationId,
              email
            }
          }
        });

        await writeAuditEvent(tx, {
          organizationId: bootstrapOrganizationId,
          actorId: account.id,
          action: "identity.account.suspend",
          resourceType: "identity",
          resourceId: account.id,
          ipAddress: "127.0.0.1",
          before: { status: "ACTIVE", password: "not-visible" },
          after: { status: "SUSPENDED", token: "not-visible" },
          reason: "E2E audit identity action",
          requestId: `${requestId}-identity`,
          occurredAt: new Date()
        });
        await writeAuditEvent(tx, {
          organizationId: bootstrapOrganizationId,
          actorId: account.id,
          action: "reservation.revenue.reversed",
          resourceType: "financial_transaction",
          resourceId: null,
          ipAddress: "127.0.0.1",
          before: { transactionIds: ["tx-before"] },
          after: { transactionIds: ["tx-after"] },
          reason: "E2E audit reversal reason",
          requestId: `${requestId}-finance`,
          occurredAt: new Date()
        });

        return {
          identityRequestId: `${requestId}-identity`,
          financeRequestId: `${requestId}-finance`
        };
      }
    );
  } finally {
    await prisma.$disconnect();
  }
}

test.describe("audit trail", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for audit E2E");

  test("admin views, filters and exports audit records", async ({ page }, testInfo) => {
    const adminEmail = e2eEmail(`audit-admin-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(adminEmail, adminPassword);
    const seeded = await seedAuditRecords(adminEmail, testInfo.project.name);
    await login(page, adminEmail);

    await page.goto("/en/app/audit");
    await expect(page.getByTestId("audit-page")).toBeVisible();
    await expect(page.getByTestId("audit-row").filter({ hasText: seeded.identityRequestId })).toContainText(
      "[REDACTED]"
    );

    await page.getByTestId("audit-action-filter").fill("reservation.revenue");
    await page.getByTestId("audit-filter-submit").click();
    await expect(page).toHaveURL(/action=reservation\.revenue/u);
    await expect(page.getByTestId("audit-row").filter({ hasText: seeded.financeRequestId })).toContainText(
      "E2E audit reversal reason"
    );
    await expect(page.getByTestId("audit-row").filter({ hasText: seeded.identityRequestId })).toHaveCount(0);

    const exportResponse = await page.request.get(
      `/api/audit/export?action=reservation.revenue&requestId=${seeded.financeRequestId}`
    );
    expect(exportResponse.status()).toBe(200);
    const csv = await exportResponse.text();
    expect(csv).toContain("reservation.revenue.reversed");
    expect(csv).toContain("E2E audit reversal reason");
  });

  test("non-audit users cannot view or export audit records", async ({ page }, testInfo) => {
    const deniedEmail = e2eEmail(`audit-denied-${Date.now()}`, testInfo.project.name);
    await ensureE2EUserWithRole(
      deniedEmail,
      adminPassword,
      "field_staff",
      "Audit Denied User"
    );
    await login(page, deniedEmail);

    await page.goto("/en/app/audit");
    await expect(page.getByTestId("audit-denied")).toBeVisible();

    const exportResponse = await page.request.get("/api/audit/export");
    expect(exportResponse.status()).toBe(403);
  });
});

