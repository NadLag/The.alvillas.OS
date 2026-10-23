import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.describe("personal notification settings", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for notification preferences E2E");
  test("saves channel and category choices across sign-in, enforces security, and supports EN FR RTL, keyboard and offline retry", async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const email = e2eEmail(`notification-preferences-${Date.now()}`, testInfo.project.name);
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
    await page.getByTestId("notification-bell").click();
    await page.getByRole("link", { name: "Notification Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/app\/notifications$/u);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const account = page.getByTestId("notification-account");
    const operations = page.getByTestId("notification-operations");
    const channel = page.getByTestId("notification-in-app-enabled");
    const save = page.getByTestId("notification-preferences-save");
    await expect(account).toBeChecked(); await expect(operations).toBeChecked();
    await expect(account).toBeEnabled();
    await account.focus(); await expect(account).toBeFocused(); await page.keyboard.press("Space");
    await expect(account).not.toBeChecked();
    await operations.uncheck();
    await save.click();
    await expect(page.getByTestId("notification-preferences").getByRole("status")).toContainText("Your preferences have been saved.");
    await channel.uncheck();
    await expect(account).toBeDisabled();
    for (const id of ["notification-security-in-app", "notification-security-email"]) {
      await expect(page.getByTestId(id)).toBeChecked(); await expect(page.getByTestId(id)).toBeDisabled();
    }
    await save.click();
    await expect(save).toBeDisabled();
    await page.goto("/en/app");
    await page.getByTestId("preferred-locale-select").selectOption("fr");
    await page.getByTestId("preferred-locale-submit").click();
    await expect(page).toHaveURL(/\/fr\/app$/u);
    await expect(page.getByTestId("notification-count")).toHaveText("0");
    await page.getByTestId("logout-button").click();
    await expect(page).toHaveURL(/\/(en|fr)\/login$/u);
    await login();
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`/${locale}/app/notifications`);
      await expect(channel).not.toBeChecked();
      await expect(account).not.toBeChecked(); await expect(operations).not.toBeChecked();
      await expect(page.getByTestId("notification-security-in-app")).toBeChecked();
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (locale === "fr") await page.screenshot({ path: testInfo.outputPath("notification-settings.png"), fullPage: true });
    }
    await page.goto("/en/app/notifications");
    await channel.check(); await account.check();
    await page.context().setOffline(true);
    await expect(page.getByTestId("notification-preferences").getByText(/You are offline/u)).toBeVisible(); await expect(save).toBeDisabled();
    await page.context().setOffline(false);
    await expect(save).toBeEnabled();
    let failNext = true;
    await page.route("**/en/app/notifications", async (route) => {
      if (route.request().method() === "POST" && route.request().postData()?.includes('"in_app"') && failNext) { failNext = false; await route.abort("failed"); }
      else await route.continue();
    });
    await save.click();
    await expect(page.getByTestId("notification-preferences").getByRole("alert")).toContainText("Your settings were not saved");
    await expect(account).toBeChecked(); await expect(operations).not.toBeChecked();
    await save.click();
    await expect(page.getByTestId("notification-preferences").getByRole("status")).toContainText("Your preferences have been saved.");
    await page.reload(); await expect(account).toBeChecked(); await expect(operations).not.toBeChecked();
    await page.unrouteAll({ behavior: "wait" });
    let failLoad = true;
    let failedLoadRequests = 0;
    await page.route("**/en/app/notifications", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"] && failLoad) {
        failedLoadRequests += 1;
        await route.abort("failed");
      }
      else await route.continue();
    });
    await page.reload();
    await expect.poll(() => failedLoadRequests).toBeGreaterThan(0);
    await expect(page.getByTestId("notification-preferences").getByRole("alert")).toContainText("Your notification settings could not be loaded");
    failLoad = false;
    await page.getByTestId("notification-preferences").getByRole("button", { name: "Try again", exact: true }).click();
    await expect(account).toBeChecked();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("redirects unauthenticated notification settings to sign-in", async ({ page }) => {
    await page.goto("/en/app/notifications");
    await expect(page).toHaveURL(/\/en\/login$/u);
    await expect(page.getByTestId("notification-settings-page")).toHaveCount(0);
  });
});
