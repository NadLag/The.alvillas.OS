import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ensureE2EAdmin, e2eEmail, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import { reservationManagementFixture, reservationAcceptanceRows, reservationPayoutBank, reservationPayoutEvidence } from "./support/reservation-management";

test.describe("F-RES-01-16 complete reservation management", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for actual reservation acceptance");
  test("imports, deduplicates, modifies, cancels and reviews calendar health in EN/FR/RTL", async ({ page }, info) => {
    test.setTimeout(180000);
    const suffix = `${info.project.name}-${Date.now()}`, email = e2eEmail(`res-management-${suffix}`, info.project.name), password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
    await ensureE2EAdmin(email, password);
    const fixture = await reservationManagementFixture(suffix);
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password); await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email);
    await expect(page).toHaveURL(/\/en\/app$/u);
    let reservationId = "";
    for (const [index, locale] of ["en", "fr", "ar"].entries()) {
      const month = String(index + 4).padStart(2, "0"), checkIn = `2029-${month}-10`, checkOut = `2029-${month}-14`;
      await page.goto(`/${locale}/app/reservations/calendar?property=${fixture.propertyId}&start=2029-${month}-01&end=2029-${String(index + 5).padStart(2, "0")}-01`);
      await expect(page.getByTestId("reservation-calendar-page")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const importer = page.getByTestId("import-reservations"); await importer.locator("..").locator("summary").click();
      await importer.locator('select[name="propertyId"]').selectOption(fixture.propertyId);
      await importer.getByTestId("reservation-import-csv").fill(`Confirmation code,Start date,End date,Guest,Guest email,Currency,Gross earnings\nHM-${locale}-${suffix},${checkIn},${checkOut},Guest ${locale},${locale}-${suffix}@example.test,MAD,5000.25`);
      await importer.locator("button[type=submit]").click();
      await expect(importer.getByRole("status")).toBeVisible();
      await expect(page.getByTestId("calendar-reservation").filter({ hasText: `Guest ${locale}` })).toHaveCount(1);

      await importer.locator("button[type=submit]").click(); await expect(importer.getByRole("status")).toBeVisible();
      await expect(page.getByTestId("calendar-reservation").filter({ hasText: `Guest ${locale}` })).toHaveCount(1);
      await page.getByTestId("calendar-reservation").filter({ hasText: `Guest ${locale}` }).getByRole("link").click();
      await expect(page.getByTestId("reservation-detail-page")).toBeVisible(); reservationId = page.url().split("/").at(-1)!;
      await expect(page.getByTestId("reservation-financial-snapshot")).toHaveCount(1);
      const modify = page.getByTestId("modify-reservation"); await modify.locator("..").locator("summary").click();
      await modify.locator('input[name="checkOut"]').fill(`2029-${month}-16`); await modify.locator('textarea[name="reason"]').fill("Guest requested two additional nights");
      await modify.getByRole("button").click(); await expect(page.getByTestId("reservation-version")).toHaveText("2");
      await expect(page.getByTestId("reservation-history-row")).toHaveCount(2); await expect(page.getByTestId("reservation-financial-snapshot")).toHaveCount(2);
      const transition = page.getByTestId("transition-reservation"); await transition.locator('select[name="status"]').selectOption("CANCELLED"); await transition.locator('textarea[name="reason"]').fill("Guest confirmed cancellation; reconcile separately"); await transition.getByRole("button").click();
      await expect(page.getByTestId("reservation-version")).toHaveText("3"); await expect(page.getByTestId("reservation-financial-snapshot")).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    const rows = await reservationAcceptanceRows(fixture.propertyId);
    expect(rows.reservations).toHaveLength(3); expect(rows.reservations.every(r => r.status === "CANCELLED")).toBe(true); expect(rows.tasks).toHaveLength(6); expect(rows.tasks.every(task => task.state === "CANCELLED")).toBe(true); expect(rows.snapshots).toBe(9);
    const bank = await reservationPayoutBank(fixture.propertyId), sourceId = `PAYOUT-${suffix}`, transactionId = `TX-${suffix}`;
    await page.goto(`/en/app/reservations/calendar?property=${fixture.propertyId}&start=2029-09-01&end=2029-10-01`);
    const payoutImport = page.getByTestId("import-reservations"); await payoutImport.locator("..").locator("summary").click(); await payoutImport.getByTestId("reservation-import-csv").fill(`Confirmation code,Start date,End date,Guest,Currency,Gross earnings\n${sourceId},2029-09-10,2029-09-14,${sourceId},MAD,5500.00`); await payoutImport.locator("button[type=submit]").click(); await expect(payoutImport.getByRole("status")).toBeVisible();
    await page.getByTestId("calendar-reservation").filter({ hasText: sourceId }).getByRole("link").click(); await expect(page.getByTestId("reservation-detail-page")).toBeVisible(); const payoutReservationId = page.url().split("/").at(-1)!;
    await page.goto("/en/app/reservations");
    const payoutCsv = `source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action\n${sourceId},PO-${suffix},${transactionId},MAD,5500.00,300.00,5200.00,5150.00,Bank fee,Review payout`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByTestId("airbnb-settlement-account").selectOption(bank.id); await page.getByTestId("airbnb-settlement-csv").fill(payoutCsv);
      const completed = page.waitForResponse(response => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]) && new URL(response.url()).pathname.endsWith("/reservations"));
      await page.getByTestId("airbnb-settlement-submit").click(); expect((await completed).status()).toBeLessThan(400);
      await expect(page.getByTestId("airbnb-settlement-variance").filter({ hasText: fixture.propertyName })).toHaveAttribute("data-variance", "50.00");
    }
    const payoutBefore = await reservationPayoutEvidence(fixture.propertyId, transactionId); expect(payoutBefore).toMatchObject({ settlements: 1, originals: 2, reversals: 0 });
    await page.goto(`/en/app/reservations/${payoutReservationId}`); const cancelPayout = page.getByTestId("transition-reservation"); await cancelPayout.locator('select[name="status"]').selectOption("CANCELLED"); await cancelPayout.locator('textarea[name="reason"]').fill("Cancellation of paid OTA acceptance booking"); await cancelPayout.getByRole("button").click(); await expect(page.getByTestId("reservation-version")).toHaveText("2");
    const refundPayout = page.getByTestId("refund-reservation"); await refundPayout.locator("..").locator("summary").click(); await refundPayout.locator('textarea[name="reason"]').fill("Full OTA refund including actual payout receipt"); await refundPayout.getByRole("button").click(); await expect(page.getByTestId("reservation-version")).toHaveText("3");
    const payoutAfter = await reservationPayoutEvidence(fixture.propertyId, transactionId); expect(payoutAfter).toMatchObject({ settlements: 1, originals: 2, reversals: 2, zeroBalances: true }); expect(payoutAfter.fingerprint).toBe(payoutBefore.fingerprint);
    await page.goto(`/en/app/reservations/calendar?property=${fixture.propertyId}&start=2029-04-01&end=2029-05-01`);
    const connect = page.getByTestId("connect-reservation-feed"); await connect.locator('select[name="propertyId"]').selectOption(fixture.propertyId); await connect.locator('input[name="name"]').fill(`Feed ${suffix}`); await connect.locator('input[name="url"]').fill("https://ical-reservation-acceptance.invalid/calendar.ics"); await connect.getByRole("button").click(); await expect(connect.getByRole("status")).toBeVisible();
    const feed = page.getByTestId("reservation-feed").filter({ hasText: `Feed ${suffix}` });
    const syncCompleted = page.waitForResponse(response => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]) && new URL(response.url()).pathname.endsWith("/reservations/calendar"));
    await feed.getByTestId("sync-reservation-feed").getByRole("button").click();
    expect((await syncCompleted).status()).toBeLessThan(400);
    await expect(feed.getByTestId("sync-reservation-feed").getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("reservation-exception").filter({ hasText: "Calendar sync failed" })).toBeVisible();
    await feed.getByTestId("toggle-reservation-feed").getByRole("button").click(); await expect(feed).toContainText("Sync paused");
    await page.goto("/en/app"); await expect(page.getByTestId("reservation-command-exceptions")).toBeVisible();
    await page.context().clearCookies(); await page.goto(`/en/app/reservations/${reservationId}`); await expect(page).toHaveURL(/\/en\/login/u);
  });
});
