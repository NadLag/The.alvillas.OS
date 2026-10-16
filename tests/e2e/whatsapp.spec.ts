import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.describe("manual WhatsApp notification", () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for actual authenticated WhatsApp journeys");
  test("creates guest contacts, previews scoped localized messages and manually opens an audited WhatsApp link", async ({ page, context }, testInfo) => {
    test.setTimeout(180000);
    const suffix = `wa-${testInfo.project.name}-${Date.now()}`;
    const email = e2eEmail(suffix, testInfo.project.name);
    const password = "correct horse battery staple";
    await ensureE2EAdmin(email, password);
    const client = new PrismaClient();
    try {
      const account = await client.userAccount.findFirstOrThrow({ where: { email } });
      const owner = await client.owner.create({ data: { organizationId: account.organizationId, displayName: `WA owner ${suffix}`, phone: "+33612345678", preferredLocale: "en" } });
      const property = await client.property.create({ data: { organizationId: account.organizationId, name: `WA villa ${suffix}`, addressLine1: "Private road", city: "Marrakech", propertyType: "Villa", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [], propertyOwners: { create: { organizationId: account.organizationId, ownerId: owner.id } } } });
      // Keep the existing revenue controls present: the WhatsApp action must stay
      // reachable beside financial controls as well as on an empty database.
      await client.ledgerAccount.create({ data: { organizationId: account.organizationId, code: `WA_${Date.now()}_${testInfo.workerIndex}`, name: `WA bank ${suffix}`, accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
      await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
      await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password); await page.getByTestId("login-submit").click();
      await completeE2EAdminMfa(page, email); await expect(page).toHaveURL(/\/en\/app$/u);
      if (testInfo.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/en/app/reservations"); await page.getByTestId("reservation-property").selectOption(property.id);
      await page.getByTestId("reservation-guest-name").fill("Private guest name"); await page.getByTestId("reservation-guest-email").fill(`private-${suffix}@example.test`);
      await page.getByTestId("reservation-guest-phone").fill("0612345678"); await page.getByTestId("reservation-check-in").fill("2027-06-10"); await page.getByTestId("reservation-check-out").fill("2027-06-14");
      await page.getByTestId("reservation-submit").click(); await expect(page.getByTestId("reservation-guest-phone").locator("..").getByRole("alert")).toBeVisible();
      await page.getByTestId("reservation-guest-phone").fill("+212 612345678"); await page.getByTestId("reservation-guest-locale").selectOption("fr");
      await page.getByTestId("reservation-guest-phone").blur();
      await expect(page.getByTestId("reservation-guest-phone").locator("..").getByRole("alert")).toHaveCount(0);
      await page.getByTestId("reservation-submit").click(); await expect(page).toHaveURL(/\/en\/app\/operations$/u, { timeout: 30000 });
      const reservation = await client.reservation.findFirstOrThrow({ where: { propertyId: property.id } });
      expect(reservation.guestPhone).toBe("+212612345678");
      await page.goto("/en/app/reservations");
      const reservationRow = page.getByTestId("reservation-row").filter({ hasText: reservation.reference });
      await expect(reservationRow.getByTestId("reservation-revenue-account")).toBeVisible();
      const panel = await page.locator(".workspace-main").boundingBox();
      const entry = await reservationRow.getByTestId("reservation-whatsapp").boundingBox();
      expect(entry!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(entry!.x + entry!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
      await reservationRow.getByTestId("reservation-whatsapp").click();
      await expect(page.getByTestId("whatsapp-recipient")).toContainText("Guest"); await expect(page.getByTestId("whatsapp-locale")).toHaveValue("fr");
      await context.setOffline(true); await expect(page.getByTestId("whatsapp-prepare")).toBeDisabled(); await context.setOffline(false);
      let abort = true;
      await page.route("**/en/app/notifications/whatsapp**", async (route) => { if (route.request().method() === "POST" && route.request().postData()?.includes('"recipient"') && abort) { abort = false; await route.abort(); } else await route.continue(); });
      await page.getByTestId("whatsapp-prepare").click(); await expect(page.getByTestId("whatsapp-composer").getByRole("alert")).toBeVisible();
      await page.getByTestId("whatsapp-prepare").click(); await expect(page.getByTestId("whatsapp-message")).toContainText("Bonjour");
      expect(await page.getByTestId("whatsapp-message").inputValue()).not.toContain("Private guest");
      const popupPromise = context.waitForEvent("page");
      const externalRequest = context.waitForEvent("request", (request) => new URL(request.url()).origin === "https://wa.me");
      await page.getByTestId("whatsapp-open").focus(); await page.keyboard.press("Enter");
      const popup = await popupPromise;
      const url = new URL((await externalRequest).url()); expect(url.pathname).toBe("/212612345678"); expect(url.searchParams.get("text")).toContain("Bonjour"); await popup.close();
      const base = `/app/notifications/whatsapp?type=reservation&id=${reservation.id}`;
      for (const locale of ["en", "fr", "ar"]) {
        await page.goto(`/${locale}${base}`); await page.getByTestId("whatsapp-locale").selectOption(locale); await page.getByTestId("whatsapp-prepare").click();
        await expect(page.getByTestId("whatsapp-message")).toBeVisible(); await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await page.evaluate((width) => document.documentElement.scrollWidth <= width, page.viewportSize()!.width)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
      await page.goto(`/en${base}`); await page.getByTestId("whatsapp-recipient").selectOption("1"); await expect(page.getByTestId("whatsapp-locale")).toHaveValue("en");
      await page.getByTestId("whatsapp-prepare").click(); await expect(page.getByTestId("whatsapp-preview")).toContainText("+33612345678");
      for (const [phone, expected] of [[null, "has no phone number"], ["invalid", "phone number is invalid"]] as const) {
        await client.reservation.update({ where: { id: reservation.id }, data: { guestPhone: phone } });
        await page.reload(); await page.getByTestId("whatsapp-prepare").click(); await expect(page.getByTestId("whatsapp-composer").getByRole("alert")).toContainText(expected);
        await expect(page.getByTestId("whatsapp-open")).toHaveCount(0);
      }
      await page.getByText("Update guest contact", { exact: true }).click();
      await page.getByTestId("whatsapp-contact-phone").fill("+447911123456"); await page.getByTestId("whatsapp-contact-locale").selectOption("en");
      await page.getByTestId("whatsapp-contact-save").click(); await expect(page.getByTestId("whatsapp-composer").getByRole("status")).toContainText("Guest contact saved.");
      await page.reload(); await expect(page.getByTestId("whatsapp-locale")).toHaveValue("en"); await page.getByTestId("whatsapp-prepare").click();
      await expect(page.getByTestId("whatsapp-preview")).toContainText("+447911123456");
      await page.getByText("Update guest contact", { exact: true }).click(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.goto("/en/app/operations");
      expect(await page.evaluate((width) => document.documentElement.scrollWidth <= width, page.viewportSize()!.width)).toBe(true);
      await page.getByTestId("operation-task-row").filter({ hasText: property.name }).first().getByTestId("task-whatsapp").click();
      // The default property task routing includes the assigned account.
      await expect(page.getByTestId("whatsapp-recipient")).toContainText("Operations");
      await page.goto("/en/app/field"); await page.getByTestId("field-task-card").filter({ hasText: property.name }).first().click();
      await page.getByTestId("task-whatsapp").click(); await expect(page.getByTestId("whatsapp-composer")).toBeVisible();
      await page.getByTestId("notification-bell").click(); await page.getByTestId("notification-whatsapp").first().click(); await expect(page.getByTestId("whatsapp-page")).toBeVisible();
      expect((await page.request.post("/api/notifications/whatsapp/open", { form: { type: "reservation", id: reservation.id } })).status()).toBe(403);
      expect((await page.request.post("/api/notifications/whatsapp/open", { headers: { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" }, form: { type: "reservation", id: reservation.id } })).status()).toBe(403);
      const audits = await client.auditLog.findMany({ where: { organizationId: account.organizationId, action: "notification.whatsapp.opened", resourceId: reservation.id } });
      expect(audits).toHaveLength(1); expect(JSON.stringify(audits)).not.toMatch(/612345678|Private guest|wa\.me/u);
      await page.goto("/en/app/notifications/whatsapp?type=reservation&id=018f0a0b-0000-7000-9000-000000000099");
      await expect(page.getByTestId("whatsapp-composer")).toHaveCount(0);
    } finally { await client.$disconnect(); }
  });
});
