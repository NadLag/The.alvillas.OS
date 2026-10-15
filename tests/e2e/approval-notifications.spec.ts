import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { setPropertyCity } from "./support/property-form";

test.describe("approval notification lifecycle", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for real approval E2E");
  test("configured approver opens each real request from notifications and approves or rejects on desktop and mobile", async ({ page, browser }, testInfo) => {
    test.setTimeout(240000);
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const requesterEmail = e2eEmail("approval-requester", suffix); const approverEmail = e2eEmail("approval-approver", suffix);
    const password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
    await ensureE2EAdmin(requesterEmail, password); await ensureE2EAdmin(approverEmail, password);
    async function login(target: typeof page, email: string) {
      await target.goto("/en/login"); await waitForE2EAdminLoginWindow(target, email);
      await target.getByTestId("login-email").fill(email); await target.getByTestId("login-password").fill(password);
      await target.getByTestId("login-submit").click(); await completeE2EAdminMfa(target, email); await expect(target).toHaveURL(/\/en\/app$/u);
    }
    await login(page, requesterEmail);
    const client = new PrismaClient(); const approverContext = await browser.newContext({ baseURL: "http://127.0.0.1:3000", viewport: page.viewportSize(), isMobile: testInfo.project.name === "field-mobile" });
    try {
      const approver = await client.userAccount.findFirstOrThrow({ where: { email: approverEmail } });
      const ownerName = `Approval owner ${suffix}`; const propertyName = `Approval villa ${suffix}`;
      await page.goto("/en/app/owners"); await page.getByTestId("owner-display-name").fill(ownerName);
      await page.getByTestId("owner-email").fill(`approval-owner-${suffix}@example.test`); await page.getByTestId("owner-submit").click();
      await expect(page.getByRole("heading", { name: ownerName })).toBeVisible(); await page.goto("/en/app/properties");
      await page.getByTestId("property-owner").selectOption({ label: ownerName }); await page.getByTestId("property-name").fill(propertyName);
      await page.getByTestId("property-type").fill("Villa"); await page.getByTestId("property-address").fill("Approval road"); await setPropertyCity(page, "Marrakech");
      await page.getByTestId("property-bedrooms").fill("2"); await page.getByTestId("property-bathrooms").fill("2"); await page.getByTestId("property-max-guests").fill("4");
      await page.getByTestId("property-submit").click(); await expect(page).toHaveURL(/\/en\/app\/properties\/[a-f0-9-]+$/u, { timeout: 30000 }); await expect(page.getByRole("heading", { name: propertyName })).toBeVisible();
      const property = await client.property.findFirstOrThrow({ where: { name: propertyName, organizationId: approver.organizationId } });
      await page.goto("/en/app/notifications"); await expect(page.getByTestId("routing-in-app")).toBeVisible();
      await page.getByTestId("routing-event").selectOption("approval_requested"); await expect(page.getByTestId("routing-in-app")).toBeVisible();
      await page.getByTestId("routing-scope").selectOption(property.id); await page.getByTestId(`routing-person-${approver.personId}`).check();
      await page.getByTestId("routing-reason").fill("Route property approvals to the configured reviewer"); await page.getByTestId("routing-save").click();
      await expect(page.getByTestId("routing-status")).toContainText("Routing saved");
      const reviewer = await approverContext.newPage(); await login(reviewer, approverEmail);
      if (testInfo.project.name === "field-mobile") { await page.setViewportSize({ width: 360, height: 800 }); await reviewer.setViewportSize({ width: 360, height: 800 }); }
      for (const decision of ["APPROVED", "REJECTED"] as const) {
        await page.goto(`/en/app/properties/${property.id}/approvals/new`);
        await page.getByTestId("approval-title").fill(`Review inspection ${decision}`); await page.getByTestId("approval-details").fill("Please review the proposed inspection schedule for this property.");
        await page.context().setOffline(true); await expect(page.getByTestId("approval-request")).toBeDisabled(); await page.context().setOffline(false);
        await page.getByTestId("approval-request").click(); await expect(page).toHaveURL(/\/en\/app\/approvals\/[a-f0-9-]+$/u);
        const id = page.url().split("/").at(-1)!; await expect(page.getByTestId("approval-approve")).toHaveCount(0);
        await reviewer.reload(); await reviewer.getByTestId("notification-bell").click();
        const notice = reviewer.getByTestId("notification-item").filter({ hasText: "An approval needs your decision." }).filter({ has: reviewer.getByText("Unread", { exact: true }) });
        await expect(notice).toHaveCount(1); await notice.getByRole("button", { name: "Open record", exact: true }).click();
        await expect(reviewer).toHaveURL(new RegExp(`/en/app/approvals/${id}$`, "u"));
        await reviewer.getByTestId("approval-reason").fill(`Inspection schedule ${decision.toLowerCase()} after review`);
        if (decision === "APPROVED") {
          let failNext = true;
          await reviewer.route(`**/en/app/approvals/${id}`, async (route) => { if (route.request().method() === "POST" && failNext) { failNext = false; await route.abort("failed"); } else await route.continue(); });
          await reviewer.getByTestId("approval-approve").click(); await expect(reviewer.getByTestId("approval-form").getByRole("alert")).toBeVisible();
          await expect(reviewer.getByTestId("approval-reason")).toHaveValue("Inspection schedule approved after review");
        }
        await reviewer.getByTestId(decision === "APPROVED" ? "approval-approve" : "approval-reject").click();
        await expect(reviewer.getByTestId("approval-state")).toHaveText(decision === "APPROVED" ? "Approved" : "Rejected");
        await reviewer.unrouteAll({ behavior: "wait" }); await reviewer.reload(); await expect(reviewer.getByTestId("approval-approve")).toHaveCount(0);
        await reviewer.getByTestId("notification-bell").click(); await expect(reviewer.getByTestId("notification-resolution").filter({ hasText: decision === "APPROVED" ? "Approved" : "Rejected" })).toHaveCount(1);
        await reviewer.keyboard.press("Escape");
        for (const locale of ["en", "fr", "ar"]) {
          await reviewer.goto(`/${locale}/app/approvals/${id}`); await expect(reviewer.getByTestId("approval-state")).toBeVisible();
          await expect(reviewer.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
          expect(await reviewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect((await new AxeBuilder({ page: reviewer }).analyze()).violations).toEqual([]);
          await reviewer.screenshot({ path: testInfo.outputPath(`approval-${decision}-${locale}.png`), fullPage: true });
        }
        await reviewer.goto(`/en/app/approvals/${id}`);
        await page.reload(); await page.getByTestId("notification-bell").click();
        await expect(page.getByTestId("notification-item").filter({ hasText: "An approval decision was recorded." })).toHaveCount(decision === "APPROVED" ? 1 : 2);
        await page.keyboard.press("Escape");
      }
    } finally { await approverContext.close(); await client.$disconnect(); }
  });
});
