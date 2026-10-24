import { expect, test } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { setPropertyCity } from "./support/property-form";
import { ensureReservationRevenuePostingSetup } from "./support/reservation-revenue";
import { formatCurrencyAmount } from "@/i18n/format";
import { preferOperationPerformer } from "./support/operation-policy";

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
    await waitForE2EAdminLoginWindow(page, loginEmail);
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, loginEmail);
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
    const propertyCity = await setPropertyCity(page, "Marrakech");
    await page.getByTestId("property-bedrooms").fill("4");
    await page.getByTestId("property-bathrooms").fill("4");
    await page.getByTestId("property-max-guests").fill("8");
    await page.getByTestId("property-submit").click();
    await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();
    await preferOperationPerformer(loginEmail, propertyName);

    await page.goto("/en/app/reservations");
    await expect(page.getByTestId("reservations-page")).toBeVisible();
    await page.getByTestId("reservation-property").selectOption({ label: `${propertyName} - ${propertyCity}` });
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

    await expect(page.getByTestId("notification-count")).toHaveText("2");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-item")).toHaveCount(2);
    await page.getByRole("button", { name: "Open record", exact: true }).first().click();
    await expect(page.getByTestId("notification-panel")).not.toBeVisible();
    await expect(page.getByTestId("field-task-page")).toBeVisible();
    await expect(page.getByTestId("notification-count")).toHaveText("1");
    await page.goto("/en/app/field");
    await page.getByTestId("field-view-assigned").click();
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
    await page.context().setOffline(true);
    await page.getByTestId("field-task-complete").click();
    await expect(page.getByTestId("field-task-sync-status")).toContainText("Saved offline");
    await page.context().setOffline(false);
    await expect(page).toHaveURL(/\/en\/app\/field/u);
    await page.getByTestId("field-view-assigned").click();
    await expect(page.getByTestId("field-task-card").filter({ hasText: propertyName })).toHaveCount(1);
  });

  test("records accommodation revenue and updates the owner statement", async ({ page }, testInfo) => {
    const suffix = `s6-${testInfo.project.name}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const ownerName = `S6 Revenue Owner ${suffix}`;
    const ownerEmail = `s6-revenue-owner-${suffix}@example.test`;
    const propertyName = `S6 Revenue Villa ${suffix}`;
    const guestName = `S6 Revenue Guest ${suffix}`;
    const loginEmail = e2eEmail(`s6-revenue-${suffix}`, testInfo.project.name);

    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await waitForE2EAdminLoginWindow(page, loginEmail);
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, loginEmail);
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
    const propertyCity = await setPropertyCity(page, "Marrakech");
    await page.getByTestId("property-bedrooms").fill("4");
    await page.getByTestId("property-bathrooms").fill("4");
    await page.getByTestId("property-max-guests").fill("8");
    await page.getByTestId("property-submit").click();
    await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();

    const financeSetup = await ensureReservationRevenuePostingSetup({
      ownerEmail,
      propertyName,
      password: adminPassword
    });

    await page.goto("/en/app/reservations");
    await expect(page.getByTestId("reservations-page")).toBeVisible();
    await page.getByTestId("reservation-property").selectOption({ label: `${propertyName} - ${propertyCity}` });
    await page.getByTestId("reservation-guest-name").fill(guestName);
    await page.getByTestId("reservation-guest-email").fill(`guest-${suffix}@example.test`);
    await page.getByTestId("reservation-check-in").fill("2028-04-10");
    await page.getByTestId("reservation-check-out").fill("2028-04-14");
    await page.getByTestId("reservation-adults").fill("2");
    await page.getByTestId("reservation-children").fill("0");
    await page.getByTestId("reservation-submit").click();
    await expect(page).toHaveURL(/\/en\/app\/operations/u);

    await page.goto("/en/app/reservations");
    const reservationRow = page.getByTestId("reservation-row").filter({ hasText: guestName });
    await expect(reservationRow).toBeVisible();
    await reservationRow.getByTestId("reservation-revenue-amount").fill("8000.00");
    await reservationRow.getByTestId("reservation-revenue-account").selectOption({
      label: financeSetup.bankName
    });
    await reservationRow.getByTestId("reservation-revenue-submit").click();
    await expect(reservationRow.getByTestId("reservation-revenue-posted")).toContainText("Revenue posted");

    await page.context().clearCookies();
    await page.goto("/en/login");
    await waitForE2EAdminLoginWindow(page, ownerEmail);
    await page.getByTestId("login-email").fill(ownerEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, ownerEmail);
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.goto("/en/app/owner-portal");
    await expect(page.getByTestId("owner-property-row").filter({ hasText: propertyName })).toBeVisible();
    await page.getByTestId("owner-property-row").filter({ hasText: propertyName }).click();
    await expect(page).toHaveURL(new RegExp(`/en/app/owner-portal/properties/${financeSetup.propertyId}`));
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute("data-amount", "6400.00");
    await expect(page.getByTestId("owner-bucket-total").filter({ hasText: "Owner revenue" })).toBeVisible();
    await expect(page.getByTestId("owner-bucket-total").filter({ hasText: "Commission" })).toBeVisible();
  });

  test("imports an Airbnb settlement CSV and shows the payout variance", async ({ page }, testInfo) => {
    const suffix = `s7-${testInfo.project.name}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const ownerName = `S7 Airbnb Owner ${suffix}`;
    const ownerEmail = `s7-airbnb-owner-${suffix}@example.test`;
    const propertyName = `S7 Airbnb Villa ${suffix}`;
    const guestName = `S7 Airbnb Guest ${suffix}`;
    const loginEmail = e2eEmail(`s7-airbnb-${suffix}`, testInfo.project.name);
    const sourceTransactionId = `TX-${suffix}`;

    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await waitForE2EAdminLoginWindow(page, loginEmail);
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, loginEmail);
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
    const propertyCity = await setPropertyCity(page, "Marrakech");
    await page.getByTestId("property-bedrooms").fill("4");
    await page.getByTestId("property-bathrooms").fill("4");
    await page.getByTestId("property-max-guests").fill("8");
    await page.getByTestId("property-submit").click();
    await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();

    const financeSetup = await ensureReservationRevenuePostingSetup({
      ownerEmail,
      propertyName,
      password: adminPassword
    });

    await page.goto("/en/app/reservations");
    await expect(page.getByTestId("reservations-page")).toBeVisible();
    await page.getByTestId("reservation-property").selectOption({ label: `${propertyName} - ${propertyCity}` });
    await page.getByTestId("reservation-guest-name").fill(guestName);
    await page.getByTestId("reservation-guest-email").fill(`guest-${suffix}@example.test`);
    await page.getByTestId("reservation-source").selectOption("AIRBNB");
    await page.getByTestId("reservation-external-id").fill(`HM-${suffix}`);
    await page.getByTestId("reservation-check-in").fill("2028-05-10");
    await page.getByTestId("reservation-check-out").fill("2028-05-14");
    await page.getByTestId("reservation-adults").fill("2");
    await page.getByTestId("reservation-children").fill("0");
    await page.getByTestId("reservation-submit").click();
    await expect(page).toHaveURL(/\/en\/app\/operations/u);

    await page.goto("/en/app/reservations");
    const reservationRow = page.getByTestId("reservation-row").filter({ hasText: guestName });
    await expect(reservationRow).toBeVisible();
    await page.getByTestId("airbnb-settlement-account").selectOption({
      label: financeSetup.bankName
    });
    await page.getByTestId("airbnb-settlement-csv").fill(
      [
        "source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action",
        `HM-${suffix},PO-${suffix},${sourceTransactionId},MAD,5500.00,300.00,5200.00,5150.00,Bank fee,Review payout`
      ].join("\n")
    );
    await page.getByTestId("airbnb-settlement-submit").click();

    const variance = page.getByTestId("airbnb-settlement-variance").filter({ hasText: propertyName });
    await expect(variance).toBeVisible();
    await expect(variance).toHaveAttribute("data-expected", "5200.00");
    await expect(variance).toHaveAttribute("data-actual", "5150.00");
    await expect(variance).toHaveAttribute("data-variance", "50.00");
    await expect(variance.getByTestId("airbnb-settlement-variance-amount")).toHaveText(
      formatCurrencyAmount("en", "50.00", "MAD")
    );
    await expect(variance).toContainText("Bank fee");
    await expect(variance).toContainText("Review payout");
  });
});
