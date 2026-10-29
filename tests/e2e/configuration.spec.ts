import { expect, test, type Page } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { setPropertyCity } from "./support/property-form";
import { ensureReservationRevenuePostingSetup } from "./support/reservation-revenue";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function expectConfigRuleCreated(page: Page): Promise<void> {
  await expect(page.getByTestId("config-rule-form-message")).toContainText("created");
  await expect(page.getByTestId("config-rule-submit")).toBeEnabled();
  const create = page.getByTestId("config-rule-create-form"), filter = page.getByTestId("config-history-filter");
  const scopeType = await create.locator('[name="scopeType"]:checked').inputValue();
  const selectedKey = await page.getByTestId("config-rule-key").inputValue();
  const key = selectedKey === "feature_flag" ? `feature_flag.${(await create.locator('[name="customFeatureFlagKey"]').inputValue()).trim()}` : selectedKey;
  await filter.locator('[name="ruleKey"]').fill(key);
  await filter.locator('[name="ruleScopeType"]').selectOption(scopeType);
  const scopeId = scopeType === "property" ? await page.getByTestId("config-rule-scope-id").inputValue() : "";
  if (scopeType === "property") await filter.getByTestId("config-history-scope-id-search").fill(scopeId);
  await filter.locator('[name="ruleScopeId"]').selectOption(scopeId);
  await filter.locator('button[type="submit"]').click();
}

async function expectCreateFormData(
  page: Page,
  expected: Record<string, string>
): Promise<void> {
  const formData = await page.getByTestId("config-rule-create-form").evaluate((form) =>
    Object.fromEntries(new FormData(form as HTMLFormElement).entries())
  );

  expect(formData).toMatchObject(expected);
}

async function selectPropertyScopedRule(
  page: Page,
  key: string,
  propertyLabel: string
): Promise<void> {
  await page.locator('input[name="scopeType"][value="property"]').check();
  await page.getByTestId("config-rule-scope-id-search").fill(propertyLabel);
  await page.getByTestId("config-rule-scope-id").selectOption({ label: propertyLabel });
  await page.getByTestId("config-rule-key").selectOption(key);
  await expect(page.getByTestId("config-rule-key")).toHaveValue(key);
}

test.describe("configuration engine journey", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for configuration E2E");

  test("creates, activates and applies property rules to tasks and commission", async ({
    page
  }, testInfo) => {
    test.setTimeout(90000);
    const suffix = `cfg-${testInfo.project.name}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const ownerName = `CFG Owner ${suffix}`;
    const ownerEmail = `cfg-owner-${suffix}@example.test`;
    const propertyName = `CFG Villa ${suffix}`;
    const guestName = `CFG Guest ${suffix}`;
    const taskTitle = `CFG turnover ${suffix}`;
    const loginEmail = e2eEmail(`configuration-${suffix}`, testInfo.project.name);

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
      password: adminPassword,
      commissionRateBps: null
    });

    await page.goto("/en/app/configuration");
    await expect(page.getByTestId("configuration-page")).toBeVisible();
    await selectPropertyScopedRule(
      page,
      "ops.reservation_task_templates",
      `${propertyName} - ${propertyCity}`
    );
    await page.getByTestId("config-rule-lifecycle").selectOption("DRAFT");
    await page.getByTestId("config-rule-value").fill(
      JSON.stringify({
        tasks: [
          {
            key: `turnover-${suffix}`,
            type: "CHECKOUT_CLEANING",
            title: { en: taskTitle, fr: taskTitle },
            due: "CHECK_OUT",
            priority: "HIGH",
            checklist: []
          }
        ]
      })
    );
    await page.getByTestId("config-rule-effective-from").fill("2000-01-01T00:00");
    await page.getByTestId("config-rule-reason").fill("CFG E2E draft task rule");
    await expectCreateFormData(page, {
      key: "ops.reservation_task_templates",
      scopeType: "property",
      lifecycle: "DRAFT",
      reason: "CFG E2E draft task rule"
    });
    await page.getByTestId("config-rule-submit").click();
    await expectConfigRuleCreated(page);

    const draftRule = page
      .getByTestId("config-rule-row")
      .filter({ hasText: "ops.reservation_task_templates" })
      .filter({ hasText: propertyName });
    await draftRule.locator('input[name="reason"]').fill("CFG E2E activate task rule");
    await draftRule.getByTestId("config-rule-activate").click();
    await expect(
      page
        .getByTestId("config-rule-row")
        .filter({ hasText: "ops.reservation_task_templates" })
        .filter({ hasText: propertyName })
        .filter({ hasText: "Active" })
    ).toBeVisible();

    await selectPropertyScopedRule(page, "finance.commission", `${propertyName} - ${propertyCity}`);
    await page.getByTestId("config-rule-lifecycle").selectOption("ACTIVE");
    await page.getByTestId("config-rule-value").fill(
      JSON.stringify({
        rate_bps: 2500,
        basis: "GROSS_ACCOMMODATION",
        accrual_event: "ON_RECEIPT"
      })
    );
    await page.getByTestId("config-rule-effective-from").fill("2000-01-01T00:00");
    await page.getByTestId("config-rule-reason").fill("CFG E2E commission rule");
    await page.getByTestId("config-rule-submit").click();
    await expectConfigRuleCreated(page);

    await selectPropertyScopedRule(page, "finance.commission", `${propertyName} - ${propertyCity}`);
    await page.getByTestId("config-rule-lifecycle").selectOption("ACTIVE");
    await page.getByTestId("config-rule-value").fill(
      JSON.stringify({
        rate_bps: 2600,
        basis: "GROSS_ACCOMMODATION",
        accrual_event: "ON_RECEIPT"
      })
    );
    await page.getByTestId("config-rule-effective-from").fill("2099-01-01T00:00");
    await page.getByTestId("config-rule-reason").fill("CFG E2E future commission rule");
    await page.getByTestId("config-rule-submit").click();
    await expectConfigRuleCreated(page);
    await expect(
      page
        .getByTestId("config-rule-row")
        .filter({ hasText: "finance.commission" })
        .filter({ hasText: propertyName })
        .filter({ hasText: "Changed" })
    ).toBeVisible();

    await page.goto("/en/app/reservations");
    await page.getByTestId("reservation-property").selectOption({ label: `${propertyName} - ${propertyCity}` });
    await page.getByTestId("reservation-guest-name").fill(guestName);
    await page.getByTestId("reservation-guest-email").fill(`guest-${suffix}@example.test`);
    await page.getByTestId("reservation-check-in").fill("2028-07-10");
    await page.getByTestId("reservation-check-out").fill("2028-07-14");
    await page.getByTestId("reservation-adults").fill("2");
    await page.getByTestId("reservation-children").fill("0");
    await page.getByTestId("reservation-submit").click();
    await expect(page).toHaveURL(/\/en\/app\/operations/u);
    await expect(page.getByTestId("operation-task-row").filter({ hasText: taskTitle })).toBeVisible();
    await expect(page.getByTestId("operation-readiness-panel")).toBeVisible();

    await page.goto("/en/app/reservations");
    const reservationRow = page.getByTestId("reservation-row").filter({ hasText: guestName });
    await reservationRow.getByTestId("reservation-revenue-amount").fill("1000.00");
    await reservationRow.getByTestId("reservation-revenue-account").selectOption({
      label: financeSetup.bankName
    });
    await reservationRow.getByTestId("reservation-revenue-submit").click();
    await expect(reservationRow.getByTestId("reservation-revenue-posted")).toContainText("Revenue posted");

    await page.goto("/en/app/configuration");
    const history = page.getByTestId("config-history-filter");
    await history.locator('[name="ruleKey"]').fill("ops.reservation_task_templates");
    await history.locator('[name="ruleScopeType"]').selectOption("property");
    await history.getByTestId("config-history-scope-id-search").fill(financeSetup.propertyId);
    await history.locator('[name="ruleScopeId"]').selectOption(financeSetup.propertyId);
    await history.locator('button[type="submit"]').click();
    const activeTaskRule = page
      .getByTestId("config-rule-row")
      .filter({ hasText: "ops.reservation_task_templates" })
      .filter({ hasText: propertyName })
      .filter({ hasText: "Active" });
    await activeTaskRule.locator('input[name="reason"]').fill("CFG E2E retire task rule");
    await activeTaskRule.getByTestId("config-rule-retire").click();
    await expect(
      page
        .getByTestId("config-rule-row")
        .filter({ hasText: "ops.reservation_task_templates" })
        .filter({ hasText: propertyName })
        .filter({ hasText: "CFG E2E retire task rule" })
        .filter({ hasText: "Retired" })
    ).toBeVisible();

    await page.context().clearCookies();
    await page.goto("/en/login");
    await waitForE2EAdminLoginWindow(page, ownerEmail);
    await page.getByTestId("login-email").fill(ownerEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, ownerEmail);
    await expect(page).toHaveURL(/\/en\/app/u);

    await page.goto(`/en/app/owner-portal/properties/${financeSetup.propertyId}`);
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute("data-amount", "750.00");
  });
});
