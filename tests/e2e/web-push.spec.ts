import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { withTenant } from "@/platform/db/tenant";
import { completeE2EAdminMfa, e2eEmail, ensureE2EAdmin, waitForE2EAdminLoginWindow } from "./support/auth";
import { installTestPushSubscription } from "./support/push";

test.use({ channel: "chromium" });

test.describe("browser push permissions", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for browser push persistence");
  test("permission denial, offline controls, revocation and logout retain secure notification history", async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const email = e2eEmail("push-permission", testInfo.project.name); const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
    await ensureE2EAdmin(email, password); await installTestPushSubscription(page, `permissions-${email}`);
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password); await page.getByTestId("login-submit").click();
    await completeE2EAdminMfa(page, email); await expect(page).toHaveURL(/\/en\/app$/u);
    await page.goto("/en/app/notifications");
    await page.getByTestId("push-enable").click(); await expect(page.getByTestId("push-disable")).toHaveCount(1);
    const client = await page.context().newCDPSession(page);
    const browserContextId = (await client.send("Target.getTargetInfo")).targetInfo.browserContextId;
    await client.send("Browser.setPermission", { browserContextId, permission: { name: "notifications" }, setting: "denied", origin: "http://127.0.0.1:3000" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("push-permission")).toContainText("Notifications are blocked."); await expect(page.getByTestId("push-enable")).toBeDisabled();
    await page.reload(); await expect(page.getByTestId("push-permission")).toContainText("Notifications are blocked."); await expect(page.getByTestId("push-disable")).toHaveCount(0);
    await page.context().setOffline(true); await expect(page.getByTestId("push-enable")).toBeDisabled(); await page.context().setOffline(false);
    await client.send("Browser.setPermission", { browserContextId, permission: { name: "notifications" }, setting: "granted", origin: "http://127.0.0.1:3000" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("push-enable")).toBeEnabled(); await page.getByTestId("push-enable").click(); await expect(page.getByTestId("push-disable")).toHaveCount(1);
    if (testInfo.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 800 });
    for (const locale of ["en", "fr", "ar"]) {
      await page.goto(`/${locale}/app/notifications`); await expect(page.getByTestId("push-enable")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    await page.goto("/en/app/notifications"); await expect(page.getByTestId("notification-security-in-app")).toBeChecked(); await expect(page.getByTestId("notification-security-in-app")).toBeDisabled();
    await page.goto("/en/app"); await page.getByTestId("logout-button").click(); await expect(page).toHaveURL(/\/en\/login$/u);
    const db = new PrismaClient();
    try {
      const account = await db.userAccount.findFirstOrThrow({ where: { email } });
      const subscriptions = await withTenant(db, account.organizationId, (tx) => tx.pushSubscription.findMany({ where: { userAccountId: account.id } }));
      expect(subscriptions.length).toBeGreaterThan(0); expect(subscriptions.every((row) => row.revokedAt !== null)).toBe(true);
      const response = await page.request.get(`/api/notifications/push/${crypto.randomUUID()}`); expect(response.status()).toBe(401);
    } finally { await db.$disconnect(); await client.detach(); }
  });
});
