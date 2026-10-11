import { expect, test } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

test.describe("manual reservation to operations tasks journey", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for reservation E2E");
  test.describe.configure({ mode: "serial" });

  test("creates a manual reservation and displays generated arrival and checkout tasks", async ({
    page
  }, testInfo) => {
    const suffix = `res-${testInfo.project.name}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const ownerName = `Reservation Owner ${suffix}`;
    const ownerEmail = `reservation-owner-${suffix}@example.test`;
    const propertyName = `Reservation Villa ${suffix}`;
    const guestName = `Reservation Guest ${suffix}`;
    const loginEmail = e2eEmail(`reservations-${suffix}`, testInfo.project.name);

    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.goto("/en/app/owners");
    await page.getByTestId("owner-display-name").fill(ownerName);
    await page.getByTestId("owner-email").fill(ownerEmail);
    await page.getByTestId("owner-preferred-locale").selectOption("en");
    await page.getByTestId("owner-submit").click();
    await expect(page.getByRole("heading", { name: ownerName })).toBeVisible();

    await page.goto("/en/app/properties");
    await page.getByTestId("property-owner").selectOption({ label: ownerName });
    await page.getByTestId("property-name").fill(propertyName);
    await page.getByTestId("property-type").fill("Villa");
    await page.getByTestId("property-address").fill("Route de Fes");
    await page.getByTestId("property-city").fill("Marrakech");
    await page.getByTestId("property-bedrooms").fill("4");
    await page.getByTestId("property-bathrooms").fill("4");
    await page.getByTestId("property-max-guests").fill("8");
    await page.getByTestId("property-submit").click();
    await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();

    await page.goto("/en/app/reservations");
    await expect(page.getByTestId("reservations-page")).toBeVisible();
    await page.getByTestId("reservation-property").selectOption({ label: `${propertyName} - Marrakech` });
    await page.getByTestId("reservation-guest-name").fill(guestName);
    await page.getByTestId("reservation-guest-email").fill(`guest-${suffix}@example.test`);
    await page.getByTestId("reservation-check-in").fill("2027-04-10");
    await page.getByTestId("reservation-check-out").fill("2027-04-14");
    await page.getByTestId("reservation-adults").fill("2");
    await page.getByTestId("reservation-children").fill("1");
    await page.getByTestId("reservation-submit").click();

    await expect(page).toHaveURL(/\/en\/app\/operations/u);
    await expect(page.getByTestId("operations-page")).toBeVisible();

    const propertyTasks = page.getByTestId("operation-task-row").filter({ hasText: propertyName });
    await expect(propertyTasks).toHaveCount(2);
    await expect(propertyTasks.filter({ hasText: "Arrival preparation" })).toHaveCount(1);
    await expect(propertyTasks.filter({ hasText: "Checkout cleaning" })).toHaveCount(1);

    await page.goto("/en/app/field");
    const fieldTask = page.getByTestId("field-task-card").filter({ hasText: propertyName }).first();
    await expect(fieldTask).toBeVisible();
    await fieldTask.click();
    await expect(page.getByTestId("field-task-page")).toBeVisible();
    await expect(page.getByTestId("field-task-title")).toContainText(/Arrival preparation|Checkout cleaning/u);

    const checklistItems = page.getByTestId("field-checklist-item");
    await expect(checklistItems).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await checklistItems.nth(index).check();
    }
    await page.getByTestId("field-task-complete").click();
    await expect(page).toHaveURL(/\/en\/app\/field/u);
    await expect(page.getByTestId("field-task-card").filter({ hasText: propertyName })).toHaveCount(1);
  });
});
