import { expect, test } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

test.describe("organization settings journey", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for organization E2E");
  test.describe.configure({ mode: "serial" });

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

  test("admin manages regions and cities before creating a scoped property", async ({
    page
  }, testInfo) => {
    const suffix = `geo-${testInfo.project.name}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const loginEmail = e2eEmail(`organization-${suffix}`, testInfo.project.name);
    const regionName = `Marrakech ${suffix}`;
    const cityName = `City ${suffix}`;
    const ownerName = `Geography Owner ${suffix}`;
    const ownerEmail = `geography-owner-${suffix}@example.test`;
    const propertyName = `Geography Villa ${suffix}`;

    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.goto("/en/app/organization/geography");
    await expect(page.getByTestId("geography-page")).toBeVisible();
    await page.getByTestId("region-name").fill(regionName);
    await page.getByTestId("region-code").fill("GEO");
    await page.getByTestId("region-description").fill("E2E managed geography region");
    await page.getByTestId("region-submit").click();
    await expect(page.getByTestId("region-form-message")).toContainText("saved");
    await expect(page.getByTestId("region-list").filter({ hasText: regionName })).toBeVisible();

    await page.getByTestId("city-name").fill(cityName);
    await page.getByTestId("city-region").selectOption({ label: regionName });
    await page.getByTestId("city-submit").click();
    await expect(page.getByTestId("city-form-message")).toContainText("saved");
    await expect(page.getByTestId("city-list").filter({ hasText: cityName })).toBeVisible();

    await page.goto("/en/app/owners");
    await page.getByTestId("owner-display-name").fill(ownerName);
    await page.getByTestId("owner-email").fill(ownerEmail);
    await page.getByTestId("owner-preferred-locale").selectOption("en");
    await page.getByTestId("owner-submit").click();
    await expect(page.getByRole("heading", { name: ownerName })).toBeVisible();

    await page.goto("/en/app/properties");
    await expect(page.getByTestId("property-city-id")).toBeVisible();
    await page.getByTestId("property-owner").selectOption({ label: ownerName });
    await page.getByTestId("property-name").fill(propertyName);
    await page.getByTestId("property-type").fill("Villa");
    await page.getByTestId("property-address").fill("Route de Fes");
    await page.getByTestId("property-city-id").selectOption({ label: `${cityName} / ${regionName}` });
    await page.getByTestId("property-bedrooms").fill("4");
    await page.getByTestId("property-bathrooms").fill("4");
    await page.getByTestId("property-max-guests").fill("8");
    await page.getByTestId("property-submit").click();

    await expect(page).toHaveURL(/\/en\/app\/properties\/[0-9a-f-]+/u);
    await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();
    await expect(page.getByTestId("property-detail-owner")).toContainText(ownerName);
  });
});
