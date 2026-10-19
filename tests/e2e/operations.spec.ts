import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";

const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
test.use({actionTimeout:30000,navigationTimeout:30000});
for (const locale of ["en", "fr", "ar"] as const) test(`Operations lifecycle, checklist, proxy history and accessibility in ${locale}`, async ({ page }, testInfo) => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for Operations browser acceptance");
  test.setTimeout(180000);
  const email = e2eEmail(`ops-${locale}`, testInfo.project.name), suffix = randomUUID().slice(0, 8);
  await test.step('enroll administrator through the security panel',()=>ensureE2EAdmin(email, password));
  const db = new PrismaClient(), org = bootstrapOrganizationId;
  const fixture = await withTenant(db, org, async tx => {
    const property = await tx.property.create({ data: { organizationId: org, name: `Operations ${suffix}`, addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
    const worker = await tx.person.create({ data: { organizationId: org, displayName: `Operator ${suffix}` } });
    const workerAccount = await tx.userAccount.create({ data: { organizationId: org, personId: worker.id } });
    await new ConfigRuleRepository(tx, org).createVersion({ key: "ops.checklists", scopeType: "property", scopeId: property.id, reason: "Browser checklist fixture", effectiveFrom: new Date("2020-01-01"), value: { checklists: [{ key: "inspection", name: { en: "Inspection", fr: "Inspection", ar: "الفحص" }, items: [{ key: "ready", label: { en: "Verify readiness", fr: "Vérifier la préparation", ar: "التحقق من الجاهزية" } }] }] } });
    return { property, worker, workerAccount };
  });
  try {
    console.info(JSON.stringify({operationsStep:'login',locale,project:testInfo.project.name}));
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email); await expect(page).toHaveURL(/\/en\/app/u);
    await page.goto(`/${locale}/app/operations/new?propertyId=${fixture.property.id}`);
    console.info(JSON.stringify({operationsStep:'create-task',locale,project:testInfo.project.name,path:new URL(page.url()).pathname}));
    const form = page.getByTestId("operation-create-form");
    await form.locator('[name="type"]').selectOption("LAUNDRY");
    await form.locator('[name="titleEn"]').fill(`Laundry ${suffix}`); await form.locator('[name="titleFr"]').fill(`Blanchisserie ${suffix}`);
    await form.locator('[name="dueDate"]').fill("2027-04-10"); await form.locator('[name="reason"]').fill("Prepare the next guest arrival");
    await form.locator('button[type="submit"]').click(); await expect(page.getByTestId("operation-detail-page")).toBeVisible();
    const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByTestId("task-history-event")).toHaveCount(1);
    console.info(JSON.stringify({operationsStep:'assign-fixture',locale,project:testInfo.project.name}));
    await withTenant(db, org, tx => tx.operationTask.update({ where: { id: taskId }, data: { state: "ASSIGNED", assignedToPersonId: fixture.worker.id, assignedToUserAccountId: fixture.workerAccount.id } }));
    await page.reload();
    const proxy = page.getByTestId("operation-proxy-form");
    console.info(JSON.stringify({operationsStep:'proxy-completion',locale,project:testInfo.project.name,path:new URL(page.url()).pathname}));
    await proxy.locator('[name="checklistItemIds"]').check(); await proxy.locator('[name="reason"]').fill("Worker unable to use phone");
    await proxy.locator('button[type="submit"]').click();
    await expect(page.getByTestId("task-performed-by")).toHaveAttribute("data-person-id", fixture.worker.id);
    const account = await withTenant(db, org, tx => tx.userAccount.findFirstOrThrow({ where: { organizationId: org, email } }));
    await expect(page.getByTestId("task-validated-by")).toHaveAttribute("data-person-id", account.personId);
    await expect(page.getByTestId("task-history-event")).toHaveCount(4);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    console.info(JSON.stringify({operationsStep:'accessibility-verified',locale,project:testInfo.project.name}));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (locale === "ar") await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await testInfo.attach(`operations-${locale}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    console.info(JSON.stringify({operationsStep:'screenshot-attached',locale,project:testInfo.project.name}));
  } finally { await db.$disconnect(); }
});
