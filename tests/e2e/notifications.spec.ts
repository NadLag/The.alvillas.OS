import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.describe("persistent personal notification center", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for notification E2E");
  test("delivers a real preference event, reads and opens it, and retains state after a fresh sign-in in EN FR and RTL", async ({ page }, testInfo) => {
    test.setTimeout(150000);
    const email = e2eEmail(`notifications-${Date.now()}`, testInfo.project.name);
    const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
    await ensureE2EAdmin(email, password);
    async function login() {
      await page.goto("/en/login");
      await waitForE2EAdminLoginWindow(page, email);
      await page.getByTestId("login-email").fill(email);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await completeE2EAdminMfa(page, email);
      await expect(page).toHaveURL(/\/(en|fr)\/app$/u);
    }
    await login();
    await expect(page.getByTestId("notification-count")).toHaveText("0");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByText("You are all caught up. Updates will appear here.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notification-bell")).toBeFocused();
    await page.getByTestId("preferred-locale-select").selectOption("fr");
    await page.getByTestId("preferred-locale-submit").click();
    await expect(page).toHaveURL(/\/fr\/app$/u);
    await page.reload();
    await expect(page.getByTestId("notification-count")).toHaveText("1");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByText("Votre langue préférée a été modifiée.")).toBeVisible();
    await page.getByRole("button", { name: "Marquer comme lue", exact: true }).click();
    await expect(page.getByTestId("notification-count")).toHaveText("0");
    await expect(page.getByTestId("notification-item")).toHaveAttribute("data-read", "true");
    await page.getByRole("button", { name: "Ouvrir la fiche", exact: true }).click();
    await expect(page).toHaveURL(/\/fr\/app$/u);
    await page.keyboard.press("Escape");
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`/${locale}/app`);
      await page.getByTestId("notification-bell").click();
      await expect(page.getByTestId("notification-item")).toHaveAttribute("data-read", "true");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
    }
    await page.goto("/en/app");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByRole("button", { name: "Open record", exact: true })).toBeEnabled();
    await page.context().setOffline(true);
    await expect(page.getByText(/You are offline/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open record", exact: true })).toBeDisabled();
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "Open record", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    let failNext = true;
    await page.route("**/en/app", async (route) => {
      if (route.request().method() === "POST" && failNext) { failNext = false; await route.abort("failed"); }
      else await route.continue();
    });
    await page.getByTestId("notification-bell").click();
    await expect(page.getByRole("alert")).toContainText("Notifications could not be updated");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("logout-button").click();
    await expect(page).toHaveURL(/\/(en|fr)\/login$/u);
    await login();
    await expect(page.getByTestId("notification-count")).toHaveText("0");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-item")).toHaveAttribute("data-read", "true");
    await page.keyboard.press("Escape");
    // Real preference events create enough history to scroll on both viewports.
    for (const locale of ["en", "fr", "en", "fr", "en"]) {
      await page.getByTestId("preferred-locale-select").selectOption(locale);
      const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/app"));
      await page.getByTestId("preferred-locale-submit").click();
      expect((await saved).status()).toBeLessThan(400);
      await expect(page).toHaveURL(new RegExp(`/${locale}/app$`, "u"));
    }
    await expect(page.getByTestId("notification-count")).toHaveText("5");
    let release = () => {};
    const refreshGate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/en/app", async (route) => {
      if (route.request().method() === "POST") await refreshGate;
      await route.continue();
    });
    try {
      await page.getByTestId("notification-bell").click();
      const panel = page.getByTestId("notification-panel");
      await expect(panel).toHaveAttribute("aria-busy", "true");
      await expect(page.getByTestId("notification-item")).toHaveCount(6);
      await panel.focus();
      await expect(panel).toBeFocused();
      await page.keyboard.press("End");
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    } finally { release(); }
    await expect(page.getByTestId("notification-panel")).toHaveAttribute("aria-busy", "false");
  });
});
