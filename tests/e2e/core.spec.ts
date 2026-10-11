import { expect, test } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

test.describe("owners and properties journey", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for core E2E");
  test.describe.configure({ mode: "serial" });

  test("creates an owner, creates a property, and opens both detail screens", async ({
    page
  }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    const ownerName = `Owner ${suffix}`;
    const ownerEmail = `owner-${suffix}@example.test`;
    const propertyName = `Villa ${suffix}`;
    const loginEmail = e2eEmail(`core-${suffix}`, testInfo.project.name);

    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.getByRole("link", { name: "Owners" }).click();
    await expect(page.getByTestId("owners-page")).toBeVisible();
    await page.getByTestId("owner-display-name").fill(ownerName);
    await page.getByTestId("owner-email").fill(ownerEmail);
    await page.getByTestId("owner-preferred-locale").selectOption("en");
    await page.getByTestId("owner-submit").click();

    await expect(page).toHaveURL(/\/en\/app\/owners\/[0-9a-f-]+/u);
    await expect(page.getByTestId("owner-detail-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: ownerName })).toBeVisible();
    await expect(page.getByTestId("owner-detail-email")).toContainText(ownerEmail);

    await page.goto("/en/app/properties");
    await expect(page.getByTestId("properties-page")).toBeVisible();
    await page.getByTestId("property-owner").selectOption({ label: ownerName });
    await page.getByTestId("property-name").fill(propertyName);
    await page.getByTestId("property-type").fill("Villa");
    await page.getByTestId("property-address").fill("Route de Fes");
    await page.getByTestId("property-city").fill("Marrakech");
    await page.getByTestId("property-bedrooms").fill("4");
    await page.getByTestId("property-bathrooms").fill("4");
    await page.getByTestId("property-max-guests").fill("8");
    await page.getByTestId("property-has-pool").check();
    await page.getByTestId("property-amenities").fill("Pool, Garden, Fiber");
    await page.getByTestId("property-submit").click();

    await expect(page).toHaveURL(/\/en\/app\/properties\/[0-9a-f-]+/u);
    await expect(page.getByTestId("property-detail-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();
    await expect(page.getByTestId("property-detail-owner")).toContainText(ownerName);
  });
});
