import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { hashPassword } from "@/platform/auth/password";
import { withTenant } from "@/platform/db/tenant";
import { HouseholdRepository } from "@/modules/personal/infrastructure/household-repository";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

const copy = { en: en.Personal, fr: fr.Personal, ar: ar.Personal };

async function login(page: Page, email: string, password: string) {
  await page.goto("/en/login?surface=personal");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/personal\/[0-9a-f-]+$/u, { timeout: 30_000 });
}

test("household mutations stay private across desktop, mobile and localized views", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const dbUrl = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.VERCEL || !["localhost", "127.0.0.1"].includes(dbUrl.hostname)
    || !(dbUrl.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && dbUrl.pathname === "/alvillas_os")) {
    throw new Error("Personal browser fixtures require an isolated database");
  }
  const db = new PrismaClient({ datasourceUrl: dbUrl.toString() });
  const childContext = await browser.newContext({ baseURL, viewport: { width: 360, height: 800 } });
  try {
    const organizationId = bootstrapOrganizationId;
    const password = randomUUID() + randomUUID();
    const passwordHash = await hashPassword(password);
    async function account(displayName: string) {
      return withTenant(db, organizationId, async (tx) => {
        const person = await tx.person.create({ data: { organizationId, displayName } });
        const email = `personal-${randomUUID()}@example.test`;
        const { id: accountId } = await tx.userAccount.create({ data: {
          organizationId, personId: person.id, email, passwordHash,
          authCredentials: { create: { organizationId, type: "PASSWORD", secretHash: passwordHash } }
        } });
        return { organizationId, accountId, email };
      });
    }
    const [adult, child] = await Promise.all([account("Personal steward"), account("Personal child")]);
    const repository = new HouseholdRepository(db);
    const householdId = await repository.provision(adult, "Our household", "Steward");
    await login(page, adult.email, password);
    const t = copy.en;
    await page.getByRole("navigation", { name: t.navigation }).getByRole("link", { name: t.sections.income }).click();
    await page.getByText(t.addRecord, { exact: true }).click();
    await page.getByLabel(t.name, { exact: true }).fill("Household salary");
    await page.getByLabel(t.category, { exact: true }).fill("Salary");
    await page.getByLabel(t.amount, { exact: true }).fill("101.07");
    await page.getByLabel(t.currency, { exact: true }).fill("MAD");
    await page.getByRole("button", { name: t.save, exact: true }).click();
    await expect(page.getByText("Household salary", { exact: true })).toBeVisible();

    await page.getByRole("navigation", { name: t.navigation }).getByRole("link", { name: t.sections.members }).click();
    await page.getByText(t.addMember, { exact: true }).click();
    await page.getByLabel(t.accountId, { exact: true }).fill(child.accountId);
    await page.getByLabel(t.name, { exact: true }).fill("Child");
    await page.getByLabel(t.child, { exact: true }).check();
    await page.getByLabel(t.grantView.replace("{area}", t.sections.income), { exact: true }).check();
    await page.getByRole("button", { name: t.save, exact: true }).click();
    await expect(page.getByText("Child", { exact: true })).toBeVisible();

    const childPage = await childContext.newPage();
    await login(childPage, child.email, password);
    for (const locale of ["en", "fr", "ar"] as const) {
      await childPage.goto(`/${locale}/personal/${householdId}/income`);
      await expect(childPage.getByRole("heading", { name: copy[locale].kinds.INCOME })).toBeVisible();
      await expect(childPage.getByText("Household salary", { exact: true })).toBeVisible();
      await expect(childPage.getByText(copy[locale].addRecord, { exact: true })).toHaveCount(0);
      await expect(childPage.getByRole("link", { name: copy[locale].sections.expenses, exact: true })).toHaveCount(0);
      await expect(childPage.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await childPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect((await new AxeBuilder({ page: childPage }).analyze()).violations).toEqual([]);
    await childPage.goto(`/en/personal/${householdId}/expenses`);
    await expect(childPage.getByText("Household salary", { exact: true })).toHaveCount(0);
    await repository.scoped(adult, householdId, (scope) => scope.revokeMember(child.accountId));
    await childPage.goto(`/en/personal/${householdId}/income`);
    await expect(childPage.getByText("Household salary", { exact: true })).toHaveCount(0);
  } finally {
    await childContext.close();
    await db.$disconnect();
  }
});
