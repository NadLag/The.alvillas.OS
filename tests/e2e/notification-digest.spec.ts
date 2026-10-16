import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.describe("scheduled operational email digests", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for digest E2E");
  test("persists daily and weekly settings, locales, quiet hours, validation and offline retry with keyboard and axe", async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const email = e2eEmail(`notification-digest-${Date.now()}`, testInfo.project.name);
    const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
    await ensureE2EAdmin(email, password);
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email);
    await expect(page).toHaveURL(/\/(en|fr)\/app$/u);
    if (testInfo.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 900 });
    await page.goto("/en/app/notifications"); const panel = page.getByTestId("digest-settings");
    const frequency = page.getByTestId("digest-frequency"); const save = page.getByTestId("digest-save");
    await expect(frequency).toHaveValue("off"); await expect(panel.getByText("No digests have been scheduled yet.")).toBeVisible();
    await frequency.focus(); await page.keyboard.press("d"); await page.keyboard.press("Enter");
    await frequency.selectOption("daily"); await page.getByTestId("digest-language").selectOption("fr");
    await page.getByTestId("digest-time").fill("07:30"); await page.getByTestId("digest-timezone").fill("America/New_York");
    await page.getByTestId("digest-quiet-start").fill("22:00"); await page.getByTestId("digest-quiet-end").fill("08:00");
    await save.click(); await expect(panel.locator('[role="status"][aria-live="polite"]')).toContainText("Your digest settings have been saved.");
    await page.reload(); await expect(frequency).toHaveValue("daily");
    await frequency.selectOption("weekly"); await page.getByTestId("digest-weekday").selectOption("2"); await save.click(); await expect(save).toBeDisabled();
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`/${locale}/app/notifications`);
      await expect(frequency).toHaveValue("weekly"); await expect(page.getByTestId("digest-language")).toHaveValue("fr");
      await expect(page.getByTestId("digest-weekday")).toHaveValue("2"); await expect(page.getByTestId("digest-timezone")).toHaveValue("America/New_York");
      await expect(page.getByTestId("digest-time")).toHaveValue("07:30"); await expect(page.getByTestId("digest-quiet-end")).toHaveValue("08:00");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (locale === "fr") await panel.screenshot({ path: testInfo.outputPath("digest-settings-fr.png") });
    }
    await page.goto("/en/app/notifications");
    await page.getByTestId("digest-timezone").fill("Invalid/Timezone"); await save.click(); await expect(panel.getByRole("alert")).toContainText("Check the timezone");
    await page.getByTestId("digest-timezone").fill("Africa/Casablanca");
    await page.context().setOffline(true); await expect(panel.getByText(/You are offline/u)).toBeVisible(); await expect(save).toBeDisabled();
    await page.context().setOffline(false); await expect(save).toBeEnabled();
    let failNext = true;
    await page.route("**/en/app/notifications", async (route) => {
      if (route.request().method() === "POST" && route.request().postData()?.includes('"frequency"') && failNext) { failNext = false; await route.abort("failed"); } else await route.continue();
    });
    await save.click(); await expect(panel.getByRole("alert")).toContainText("Your digest settings were not saved");
    await expect(page.getByTestId("digest-timezone")).toHaveValue("Africa/Casablanca");
    await save.click(); await expect(panel.locator('[role="status"][aria-live="polite"]')).toContainText("Your digest settings have been saved.");
    await page.unrouteAll({ behavior: "wait" });
    await frequency.selectOption("off"); await save.click(); await expect(save).toBeDisabled();
    await page.reload(); await expect(frequency).toHaveValue("off"); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.goto(`/en/app/notifications/open/${crypto.randomUUID()}`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  });
  test("requires sign-in for email record links without exposing the target", async ({ page }) => {
    await page.goto(`/fr/app/notifications/open/${crypto.randomUUID()}`);
    await expect(page).toHaveURL(/\/fr\/login$/u);
    await expect(page.getByTestId("digest-settings")).toHaveCount(0);
  });
});
