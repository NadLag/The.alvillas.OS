import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./auth";

export async function openFieldFixture(page: Page, info: TestInfo, locale: string) {
  const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
  const email = e2eEmail(`pwa-${locale}-${randomUUID().slice(0, 8)}`, info.project.name);
  await ensureE2EAdmin(email, password);
  const db = new PrismaClient(), organizationId = bootstrapOrganizationId;
  try {
    const fixture = await withTenant(db, organizationId, async tx => {
      const account = await tx.userAccount.findFirstOrThrow({ where: { organizationId, email } });
      const property = await tx.property.create({ data: { organizationId, name: `PWA villa ${randomUUID().slice(0, 8)}`,
        addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      await new ConfigRuleRepository(tx, organizationId).createVersion({ key: "ops.checklists", scopeType: "property", scopeId: property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "PWA acceptance checklist", value: { checklists: [{ key: "inspection", name: { en: "Inspection", fr: "Inspection" },
          items: [{ key: "ready", label: { en: "Verify readiness", fr: "Vérifier la préparation", ar: "التحقق من الجاهزية" } }] }] } });
      return { account, property };
    });
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email);
    await expect(page).toHaveURL(/\/en\/app/u);
    await page.goto(`/en/app/operations/new?propertyId=${fixture.property.id}`);
    const create = page.getByTestId("operation-create-form");
    await create.locator('[name="type"]').selectOption("INSPECTION");
    await create.locator('[name="titleEn"]').fill("Inspect villa"); await create.locator('[name="titleFr"]').fill("Inspecter la villa");
    await create.locator('[name="dueDate"]').fill("2027-04-10"); await create.locator('[name="checklistTemplateKey"]').selectOption("inspection");
    await create.locator('[name="reason"]').fill("Field PWA acceptance"); await create.locator('button[type="submit"]').click();
    await expect(page.getByTestId("operation-detail-page")).toBeVisible();
    const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
    await withTenant(db, organizationId, tx => tx.operationTask.update({ where: { id: taskId }, data: {
      assignedToUserAccountId: fixture.account.id, assignedToPersonId: fixture.account.personId, state: "ASSIGNED" } }));
    if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/${locale}/app/field/${taskId}`);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    return { db, organizationId, taskId };
  } catch (error) { await db.$disconnect(); throw error; }
}
