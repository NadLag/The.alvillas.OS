import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import {
  e2eEmail,
  ensureE2EAdmin,
  completeE2EAdminMfa,
  waitForE2EAdminLoginWindow
} from "./support/auth";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { setPropertyCity } from "./support/property-form";
import {
  saveAndOpenTemplate as saveAndOpen,
  applyTemplateVersion as apply
} from "./support/template-forms";

async function loginAndProperty(page: Page, project: string, suffix: string) {
  const email = e2eEmail(`templates-${suffix}`, project),
    password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
  await ensureE2EAdmin(email, password);
  await page.goto("/en/login");
  await waitForE2EAdminLoginWindow(page, email);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await completeE2EAdminMfa(page, email);
  await expect(page).toHaveURL(/\/en\/app/u);
  const ownerName = `Template owner ${suffix}`,
    propertyName = `Villa 405 ${suffix}`;
  await page.goto("/en/app/owners");
  await page.getByTestId("owner-display-name").fill(ownerName);
  await page.getByTestId("owner-submit").click();
  await expect(page.getByRole("heading", { name: ownerName })).toBeVisible();
  await page.goto("/en/app/properties");
  await page.getByTestId("property-owner").selectOption({ label: ownerName });
  await page.getByTestId("property-name").fill(propertyName);
  await page.getByTestId("property-type").fill("Villa");
  await page.getByTestId("property-address").fill("Route de Fès");
  await setPropertyCity(page, "Marrakech");
  await page.getByTestId("property-bedrooms").fill("4");
  await page.getByTestId("property-bathrooms").fill("3");
  await page.getByTestId("property-max-guests").fill("8");
  await page.getByTestId("property-submit").click();
  await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();
  const db = new PrismaClient();
  try {
    return await withTenant(db, bootstrapOrganizationId, (tx) =>
      tx.property.findFirstOrThrow({
        where: { name: propertyName, organizationId: bootstrapOrganizationId }
      })
    );
  } finally {
    await db.$disconnect();
  }
}
test.describe("property template administration", () => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required");
  test("administrator versions a template, preserves overrides and resets selected values with EN FR RTL and accessible mobile layouts", async ({
    page,
    browser
  }, info) => {
    test.setTimeout(180000);
    const suffix = `${info.project.name}-${Date.now()}`,
      property = await loginAndProperty(page, info.project.name, suffix),
      name = `Villa standard ${suffix}`;
    await page.goto(`/en/app/templates?property=${property.id}`);
    const editor = page.getByTestId("template-editor");
    await editor.getByRole("checkbox", { name: "Bedrooms", exact: true }).check();
    await editor.getByRole("spinbutton", { name: "Bedrooms", exact: true }).fill("5");
    await editor.getByRole("checkbox", { name: "Bathrooms", exact: true }).check();
    await editor.getByRole("spinbutton", { name: "Bathrooms", exact: true }).fill("4");
    await saveAndOpen(page, `villa-${suffix}`, name);
    await apply(page);
    const bedroom = page.locator('[data-path="/property/bedrooms"]');
    await bedroom.getByRole("spinbutton").fill("6");
    await page.getByTestId("template-change-reason").fill("Property has six bedrooms");
    await page.getByTestId("template-override").click();
    await expect(page.getByTestId("template-pinned")).toContainText("property revision 2");
    await expect(bedroom).toContainText("Overridden");
    await editor.getByRole("spinbutton", { name: "Bedrooms", exact: true }).fill("7");
    await editor.getByRole("spinbutton", { name: "Bathrooms", exact: true }).fill("5");
    await page.getByTestId("template-reason").fill("Updated standard bedroom and bathroom counts");
    await page.getByTestId("template-save").click();
    await expect(page.getByTestId("template-message")).toHaveText("Saved.");
    await expect(page.getByTestId("template-update-available")).toContainText("Version 2");
    await page.getByTestId("template-card").filter({ hasText: name }).click();
    await apply(page, 2, 3);
    await expect(bedroom.getByRole("spinbutton")).toHaveValue("6");
    await expect(page.locator('[data-path="/property/bathrooms"]').getByRole("spinbutton")).toHaveValue(
      "5"
    );
    await bedroom.getByRole("checkbox").check();
    await page.getByTestId("template-change-reason").fill("Restore selected inherited bedrooms");
    await page.getByTestId("template-reset").click();
    await expect(page.getByTestId("template-pinned")).toContainText("property revision 4");
    await expect(bedroom.getByRole("spinbutton")).toHaveValue("7");
    await expect(bedroom).toContainText("Inherited");
    await expect(page.getByTestId("template-history-row")).toHaveCount(4);
    const query = new URL(page.url()).search;
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`/${locale}/app/templates${query}`);
      await expect(page.getByTestId("template-editor")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    const anonymous = await browser.newContext();
    try {
      const p = await anonymous.newPage();
      await p.goto(`/en/app/templates?property=${property.id}`);
      await expect(p).toHaveURL(/\/en\/login/u);
      await expect(p.getByTestId("template-editor")).toHaveCount(0);
    } finally {
      await anonymous.close();
    }
  });
  test("administrator creates and applies inventory workflow checklist and service catalog templates", async ({
    page
  }, info) => {
    test.setTimeout(210000);
    const suffix = `catalog-${info.project.name}-${Date.now()}`,
      property = await loginAndProperty(page, info.project.name, suffix);
    for (const kind of ["CHECKLIST", "WORKFLOW", "INVENTORY", "SERVICE_CATALOG"]) {
      await page.goto(`/en/app/templates?property=${property.id}&kind=${kind}`);
      await page.getByTestId("template-add-entry").click();
      const entry = page.getByTestId("template-entry");
      await entry
        .getByRole("textbox", { name: "Reference", exact: true })
        .fill(kind === "CHECKLIST" ? `turnover-${suffix}` : `entry-${suffix}`);
      await entry.getByRole("textbox", { name: "Name · English", exact: true }).fill(`Standard ${kind}`);
      await entry
        .getByRole("textbox", { name: "Name · French", exact: true })
        .fill(`Standard ${kind} FR`);
      if (kind === "CHECKLIST") {
        await entry.getByRole("button", { name: "Add instruction" }).click();
        const instruction = entry.locator("fieldset");
        await instruction.getByRole("textbox", { name: "Reference", exact: true }).fill("linen");
        await instruction
          .getByRole("textbox", { name: "Instruction · English", exact: true })
          .fill("Inspect linen");
        await instruction
          .getByRole("textbox", { name: "Instruction · French", exact: true })
          .fill("Inspecter le linge");
      }
      if (kind === "WORKFLOW") {
        await page.getByText("Advanced automation rules", { exact: true }).click();
        await page.getByTestId("template-automation").fill(
          JSON.stringify({
            workflows: [
              {
                key: `inspection-${suffix}`,
                trigger: "ReservationConfirmed",
                actions: [{ type: "create_task", task_type: "INSPECTION" }]
              }
            ]
          })
        );
        await entry
          .getByRole("textbox", { name: "Reusable checklist reference (optional)", exact: true })
          .fill(`turnover-${suffix}`);
      }
      if (kind === "INVENTORY") {
        await entry.getByRole("spinbutton", { name: "Minimum quantity", exact: true }).fill("8");
        await entry.getByRole("textbox", { name: "Unit", exact: true }).fill("piece");
      }
      if (kind === "SERVICE_CATALOG") {
        await entry.getByRole("textbox", { name: "Amount", exact: true }).fill("800.00");
        await entry.getByRole("textbox", { name: "Currency (ISO code)", exact: true }).fill("MAD");
      }
      await saveAndOpen(page, `${kind.toLowerCase()}-${suffix}`, `${kind} ${suffix}`);
      await apply(page);
      await expect(page.getByTestId("template-diff-row").first()).toBeVisible();
    }
  });
});
