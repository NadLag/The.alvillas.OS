import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eEmail, ensureE2EAdmin } from "./support/auth";

const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
const hasDatabase = Boolean(process.env.DATABASE_URL);

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function login(page: Page, email: string) {
  await page.goto("/en/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/en\/app/u);
}

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

test.describe("ALVILLAS design system", () => {
  test.skip(!hasDatabase, "DATABASE_URL is required for DSN E2E");

  test("renders DSN board components and supports keyboard-safe interactions", async ({ page }, testInfo) => {
    const email = e2eEmail(`dsn-board-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(email, adminPassword);
    await login(page, email);

    await page.goto("/en/app/design-system");
    await expect(page.getByTestId("design-system-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "ALVILLAS Design System" })).toBeVisible();

    const screenshot = await page.screenshot({ animations: "disabled", fullPage: true });
    expect(screenshot.byteLength).toBeGreaterThan(20_000);

    await page.getByRole("button", { name: "Open dialog" }).click();
    await expect(page.getByRole("dialog", { name: "Dialog" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Dialog" })).toHaveCount(0);

    await page.getByRole("button", { name: "Show toast" }).click();
    await expect(page.locator(".dsn-toast").getByText("Saved with audit-ready feedback.")).toBeVisible();

    await page.getByRole("tab", { name: "Shells" }).click();
    await expect(page.getByText("Field", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Finish" })).toHaveCSS("min-height", "56px");
  });

  test("holds RTL and 360px mobile layouts without overlapping primary controls", async ({ page }, testInfo) => {
    const email = e2eEmail(`dsn-mobile-${Date.now()}`, testInfo.project.name);
    await ensureE2EAdmin(email, adminPassword);
    await login(page, email);

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/ar/app/design-system");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("design-system-page")).toBeVisible();

    const headerBox = await visibleBox(page.locator(".shell-header").first());
    const boardBox = await visibleBox(page.locator(".workspace-main").first());
    expect(boxesOverlap(headerBox, boardBox)).toBe(false);

    await page.getByRole("tab", { name: "Shells" }).click();
    const fieldButton = page.getByRole("button", { name: /Finish|Terminer/ });
    const fieldButtonBox = await visibleBox(fieldButton);
    expect(fieldButtonBox.width).toBeGreaterThanOrEqual(44);
    expect(fieldButtonBox.height).toBeGreaterThanOrEqual(56);
  });
});
