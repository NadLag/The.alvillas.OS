import { expect, test } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

test.describe("organization settings journey", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for organization E2E");

  test("admin updates branding and support settings", async ({ page }, testInfo) => {
    const suffix = `org-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const loginEmail = e2eEmail(`organization-${suffix}`, testInfo.project.name);
    const brandName = "ALVILLAS E2E Organization";
    const supportEmail = "support-organization-e2e@alvillas.example.test";

    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.getByRole("link", { name: "Organization" }).click();
    await expect(page.getByTestId("organization-page")).toBeVisible();
    await expect(page.getByTestId("organization-base-currency-summary")).toContainText("MAD");

    await page.getByTestId("organization-name").fill("ALVILLAS SARL");
    await page.getByTestId("organization-brand-name").fill(brandName);
    await page.getByTestId("organization-legal-name").fill("ALVILLAS SARL");
    await page.getByTestId("organization-support-email").fill(supportEmail);
    await page.getByTestId("organization-website-url").fill("https://www.alvillas.com");
    await page.getByTestId("organization-logo-url").fill("https://assets.example.test/alvillas-logo.png");
    await page.getByTestId("organization-submit").click();

    await expect(page.getByTestId("organization-form-message")).toContainText("saved");

    await page.goto("/en/app/organization");
    await expect(page.getByTestId("organization-brand-name-summary")).toContainText(brandName);
    await expect(page.getByTestId("organization-support-email-summary")).toContainText(supportEmail);
  });
});
