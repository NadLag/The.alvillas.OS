import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);
let prisma: PrismaClient | undefined;

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function visibleBox(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();

  expect(box).not.toBeNull();

  return box!;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

test("switches login between English, French and Arabic-ready RTL", async ({ page }) => {
  await page.goto("/en/login");

  await expect(page.getByRole("heading", { name: "Sign in to ALVILLAS OS" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.getByRole("link", { name: "Francais" }).click();

  await expect(page).toHaveURL(/\/fr\/login/u);
  await expect(page.getByRole("heading", { name: "Connexion a ALVILLAS OS" })).toBeVisible();

  await page.getByTestId("locale-switch-ar").click();

  await expect(page).toHaveURL(/\/ar\/login/u);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("locale-switch-ar")).toHaveAttribute("aria-current", "page");

  const switchBox = await visibleBox(page.getByTestId("locale-switch"));
  const panelBox = await visibleBox(page.locator(".auth-panel"));
  expect(boxesOverlap(switchBox, panelBox)).toBe(false);

  await page.getByRole("link", { name: "English" }).click();

  await expect(page).toHaveURL(/\/en\/login/u);
  await expect(page.getByRole("heading", { name: "Sign in to ALVILLAS OS" })).toBeVisible();
});

test.describe("admin authentication", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for auth E2E");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    prisma = new PrismaClient();
  });

  test.beforeEach(async () => {
    await prisma?.$executeRawUnsafe("DELETE FROM rate_limit_bucket");
  });

  test.afterEach(async () => {
    await prisma?.$executeRawUnsafe("DELETE FROM rate_limit_bucket");
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/en/app");

    await expect(page).toHaveURL(/\/en\/login/u);
  });

  test("logs in and logs out the bootstrap admin", async ({ page }, testInfo) => {
    const loginEmail = e2eEmail("auth-login", testInfo.project.name);
    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/en\/app/u);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("logout-button").click();

    await expect(page).toHaveURL(/\/en\/login/u);
  });

  test("saves preferred language and uses it on the workspace", async ({ page }, testInfo) => {
    const loginEmail = e2eEmail(`auth-locale-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(loginEmail, adminPassword);

    await page.goto("/en/login");
    await page.getByTestId("login-email").fill(loginEmail);
    await page.getByTestId("login-password").fill(adminPassword);
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/en\/app/u);
    await page.getByTestId("preferred-locale-select").selectOption("fr");
    await page.getByTestId("preferred-locale-submit").click();

    await expect(page).toHaveURL(/\/fr\/app/u);
    await expect(page.getByText("Espace admin")).toBeVisible();

    await page.goto("/en/login");

    await expect(page).toHaveURL(/\/fr\/app/u);
  });

  test("rejects wrong passwords and rate limits repeated attempts", async ({ page }, testInfo) => {
    const rejectedEmail = `blocked-${testInfo.project.name}-${Date.now()}@example.test`
      .toLowerCase()
      .replace(/[^a-z0-9@.-]+/gu, "-");

    await page.goto("/en/login");

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.getByTestId("login-email").fill(rejectedEmail);
      await page.getByTestId("login-password").fill(`wrong-password-${attempt}`);
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().includes("/en/login")
        ),
        page.getByTestId("login-submit").click()
      ]);
      await expect(page.getByTestId("login-submit")).toBeEnabled();
      await expect(page.getByTestId("login-error")).toBeVisible();
    }

    await expect(page.getByTestId("login-error")).toContainText(/Too many attempts/i);
  });
});
