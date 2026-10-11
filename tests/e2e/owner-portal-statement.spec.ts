import { expect, test, type Page } from "@playwright/test";
import {
  ensureOwnerPortalScenario,
  ownerStatementTotalsFromPostgres
} from "./support/owner-portal";

const ownerPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/en/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(ownerPassword);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u);
}

test.describe("owner portal live balance and statement", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for owner portal E2E");
  test.describe.configure({ mode: "serial" });

  test("shows only authorized owner properties with ledger-derived EN and FR statements", async ({
    page
  }, testInfo) => {
    const suffix = `own-${testInfo.project.name}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    const scenario = await ensureOwnerPortalScenario({
      suffix,
      password: ownerPassword
    });
    const totals = await ownerStatementTotalsFromPostgres({
      ownerId: scenario.ownerId,
      propertyId: scenario.propertyId,
      period: scenario.period
    });
    const periodQuery = `from=${scenario.period.from}&to=${scenario.period.to}`;

    await login(page, scenario.ownerEmail);

    await page.goto("/en/app/owner-portal");
    await expect(page.getByTestId("owner-portal-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Owner portal" })).toBeVisible();
    await expect(page.getByTestId("owner-property-row")).toHaveCount(1);
    await expect(page.getByTestId("owner-property-row")).toContainText(scenario.propertyName);
    await expect(page.getByText(scenario.otherPropertyName)).toHaveCount(0);

    await page.getByTestId("owner-property-row").click();
    await expect(page.getByTestId("owner-statement-page")).toBeVisible();
    await expect(page.getByTestId("owner-statement-opening")).toHaveAttribute(
      "data-amount",
      totals.opening
    );
    await expect(page.getByTestId("owner-statement-credits")).toHaveAttribute(
      "data-amount",
      totals.credits
    );
    await expect(page.getByTestId("owner-statement-debits")).toHaveAttribute(
      "data-amount",
      totals.debits
    );
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute(
      "data-amount",
      totals.closing
    );
    await expect(page.getByTestId("owner-money-held")).toHaveAttribute(
      "data-amount",
      totals.closing
    );
    await expect(page.getByTestId("owner-statement-line")).toHaveCount(5);
    await expect(page.getByTestId("owner-bucket-total").filter({ hasText: "Owner revenue" })).toBeVisible();
    await expect(page.getByText(scenario.bankCode)).toHaveCount(0);
    await expect(page.getByText("ALVILLAS_COMMISSION")).toHaveCount(0);

    await page.goto(`/fr/app/owner-portal/properties/${scenario.propertyId}?${periodQuery}`);
    await expect(page.getByTestId("owner-statement-page")).toBeVisible();
    await expect(page.getByText("Releve en direct")).toBeVisible();
    await expect(page.getByText("Solde initial")).toBeVisible();
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute(
      "data-amount",
      totals.closing
    );

    await page.goto(`/en/app/owner-portal/properties/${scenario.otherPropertyId}?${periodQuery}`);
    await expect(page.locator("body")).toContainText(/404|not found/i);

    await page.context().clearCookies();
    await login(page, scenario.tenantEmail);
    await page.goto("/en/app/owner-portal");
    await expect(page.locator("body")).toContainText(/404|not found/i);
  });
});
