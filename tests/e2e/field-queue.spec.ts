import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { storedFieldData as stored } from "./support/field-storage";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";

const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
test.use({ actionTimeout: 30000, navigationTimeout: 30000 });
for (const locale of ["en", "fr", "ar"] as const) {
  test(`Field queue survives reload, lost acknowledgements and logout in ${locale}`, async ({ page }, info) => {
    test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for Field acceptance");
    test.setTimeout(180000);
    const email = e2eEmail(`field-${locale}`, info.project.name), t = { en, fr, ar }[locale].Field;
    await ensureE2EAdmin(email, password);
    const db = new PrismaClient(), org = bootstrapOrganizationId;
    try {
      const fixture = await withTenant(db, org, async tx => {
        const account = await tx.userAccount.findFirstOrThrow({ where: { organizationId: org, email } });
        const property = await tx.property.create({ data: { organizationId: org, name: `Offline villa ${randomUUID().slice(0, 8)}`,
          addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
        await new ConfigRuleRepository(tx, org).createVersion({ key: "ops.checklists", scopeType: "property", scopeId: property.id,
          effectiveFrom: new Date("2020-01-01"), reason: "Field queue browser fixture", value: { checklists: [{ key: "inspection",
            name: { en: "Inspection", fr: "Inspection" }, items: [{ key: "ready", label: { en: "Verify readiness", fr: "Vérifier la préparation", ar: "التحقق من الجاهزية" } }] }] } });
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
      await create.locator('[name="reason"]').fill("Field offline acceptance"); await create.locator('button[type="submit"]').click();
      await expect(page.getByTestId("operation-detail-page")).toBeVisible();
      const task = { id: new URL(page.url()).pathname.split("/").at(-1)! };
      await withTenant(db, org, tx => tx.operationTask.update({ where: { id: task.id }, data: {
        assignedToUserAccountId: fixture.account.id, assignedToPersonId: fixture.account.personId, state: "ASSIGNED" } }));
      if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(`/${locale}/app/field/${task.id}`);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect.poll(async () => (await stored(page, "metadata")).length).toBe(2);
      const check = page.getByTestId("field-checklist-item"); await check.focus(); await page.keyboard.press("Space");
      await expect(check).toBeChecked();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const note = page.getByTestId("field-task-complete-form").getByRole("textbox");
      await note.fill("Field evidence retained across reload");
      await page.context().setOffline(true); await page.getByTestId("field-task-complete").click();
      await expect(page.getByTestId("field-task-sync-status")).toHaveText(t.offlineQueued);
      const original = await stored(page); expect(original).toHaveLength(1);
      await page.context().route("**/api/sync/push", route => route.abort());
      await page.context().setOffline(false); await page.reload();
      await expect(note).toHaveValue("Field evidence retained across reload");
      await expect(check).toBeChecked(); expect(await stored(page)).toEqual(original);
      await expect(page.getByTestId("field-sync-now")).toBeEnabled();
      await page.context().unroute("**/api/sync/push");
      let lostAcknowledgement = false;
      await page.context().route("**/api/sync/push", async route => {
        const response = await route.fetch(); expect(response.ok()).toBe(true);
        lostAcknowledgement = true; await route.abort();
      });
      await page.getByTestId("field-sync-now").click();
      await expect.poll(() => lostAcknowledgement).toBe(true);
      await expect(page.getByTestId("field-task-sync-status")).toHaveText(t.offlineQueued);
      await expect.poll(() => withTenant(db, org, tx => tx.auditLog.count({ where: { action: "task.complete", resourceId: task.id } }))).toBe(1);
      expect(await stored(page)).toEqual(original);
      await page.context().unroute("**/api/sync/push"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
      expect(await stored(page)).toEqual([]);
      expect(await withTenant(db, org, tx => tx.auditLog.count({ where: { action: "task.complete", resourceId: task.id } }))).toBe(1);
      await page.goto(`/${locale}/app`); await page.getByTestId("logout-button").click();
      await expect(page).toHaveURL(new RegExp(`/${locale}/login`, "u"));
      expect(await stored(page)).toEqual([]); expect(await stored(page, "metadata")).toEqual([]);
    } finally { await db.$disconnect(); }
  });
}
