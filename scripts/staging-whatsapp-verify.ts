import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const stateFile = process.env.STAGING_STORAGE_STATE_FILE;
const taskId = process.env.STAGING_WHATSAPP_TASK_ID;
const reservationId = process.env.STAGING_WHATSAPP_RESERVATION_ID;
if (!expectedSha || !stateFile || (!taskId && !reservationId)) throw new Error("Existing staging authentication, expected SHA and a scoped record are required");
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: stateFile });
let step = "version";
let restoreContact: (() => Promise<void>) | undefined;
let contactRestored = true;
const sourceType = taskId ? "task" : "reservation";
const sourceId = taskId ?? reservationId!;
try {
  const page = await context.newPage();
  expect(await (await page.goto("/api/version"))?.json()).toMatchObject({ version: expectedSha, commitRef: "main", environment: "preview" });
  step = "existing-authentication";
  const session = await (await page.goto("/api/auth/session"))?.json() as { user?: { id?: string; securitySetupRequired?: boolean } };
  if (!session.user?.id || session.user.securitySetupRequired) throw new Error("An existing enrolled staging sign-in is required");
  if (!taskId) {
    step = "reserved-staging-contact";
    await page.goto(`/en/app/notifications/whatsapp?type=reservation&id=${sourceId}`);
    await page.getByText("Update guest contact", { exact: true }).click();
    const originalPhone = await page.getByTestId("whatsapp-contact-phone").inputValue();
    const originalLocale = await page.getByTestId("whatsapp-contact-locale").inputValue();
    if (originalPhone) throw new Error("The reversible reserved-number journey requires an empty staging contact");
    // NANP's reserved fictional range is used only to verify manual link opening.
    // No WhatsApp message is transmitted and no delivery success is recorded.
    contactRestored = false;
    restoreContact = async () => {
      await page.goto(`/en/app/notifications/whatsapp?type=reservation&id=${sourceId}`);
      await page.getByText("Update guest contact", { exact: true }).click();
      await page.getByTestId("whatsapp-contact-phone").fill(originalPhone);
      await page.getByTestId("whatsapp-contact-locale").selectOption(originalLocale);
      await page.getByTestId("whatsapp-contact-save").click();
      await expect(page.getByTestId("whatsapp-composer").getByRole("status")).toHaveText("Guest contact saved.");
      await page.reload(); await page.getByText("Update guest contact", { exact: true }).click();
      await expect(page.getByTestId("whatsapp-contact-phone")).toHaveValue(originalPhone);
      await expect(page.getByTestId("whatsapp-contact-locale")).toHaveValue(originalLocale);
      contactRestored = true;
    };
    await page.getByTestId("whatsapp-contact-phone").fill("+12025550123");
    await page.getByTestId("whatsapp-contact-save").click();
    await expect(page.getByTestId("whatsapp-composer").getByRole("status")).toHaveText("Guest contact saved.");
  }
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const locale of ["en", "fr", "ar"]) {
      step = `localized-preview-${locale}-${width}`;
      await page.goto(`/${locale}/app/notifications/whatsapp?type=${sourceType}&id=${sourceId}`);
      const choices = page.getByTestId("whatsapp-recipient").locator("option");
      const selected = await choices.evaluateAll((elements, prefixes) => elements.findIndex((element) => prefixes.some((prefix) => element.textContent?.startsWith(prefix))), taskId ? ["Operations", "Opérations", "العمليات"] : ["Guest", "Voyageur", "ضيف"]);
      if (selected < 0) throw new Error("This record has no authorized recipient");
      await page.getByTestId("whatsapp-recipient").selectOption(String(selected));
      await page.getByTestId("whatsapp-locale").selectOption(locale);
      await page.getByTestId("whatsapp-prepare").click();
      await expect(page.getByTestId("whatsapp-message")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    step = `manual-open-${width}`;
    const message = await page.getByTestId("whatsapp-message").inputValue();
    const phone = await page.getByTestId("whatsapp-preview").locator("bdi").innerText();
    const navigation = context.waitForEvent("request", (request) => new URL(request.url()).origin === "https://wa.me");
    const externalResponse = context.waitForEvent("response", (response) => new URL(response.url()).origin === "https://wa.me");
    const popup = context.waitForEvent("page");
    await page.getByTestId("whatsapp-open").focus(); await page.keyboard.press("Enter");
    const target = new URL((await navigation).url());
    expect(target.pathname).toBe(`/${phone.slice(1)}`); expect(target.searchParams.get("text")).toBe(message);
    const status = (await externalResponse).status(); expect(status).toBeGreaterThanOrEqual(200); expect(status).toBeLessThan(400);
    await (await popup).close();
  }
  if (restoreContact) { await restoreContact(); restoreContact = undefined; }
  if (reservationId) {
    step = "missing-guest-contact";
    await page.goto(`/en/app/notifications/whatsapp?type=reservation&id=${reservationId}`);
    await page.getByTestId("whatsapp-prepare").click();
    await expect(page.getByTestId("whatsapp-composer").getByRole("alert")).toContainText("has no phone number");
    await expect(page.getByTestId("whatsapp-open")).toHaveCount(0);
  }
  step = "unauthenticated-denial";
  const anonymous = await browser.newContext({ baseURL: origin });
  try {
    const target = await anonymous.newPage(); await target.goto(`/en/app/notifications/whatsapp?type=${sourceType}&id=${sourceId}`);
    await expect(target).toHaveURL(/\/en\/login$/u); await expect(target.getByTestId("whatsapp-composer")).toHaveCount(0);
  } finally { await anonymous.close(); }
  console.log(JSON.stringify({ authenticated: true, currentVersion: true, recipientKind: taskId ? "operations" : "guest", actualExternalNavigation: true,
    locales: ["en", "fr", "ar"], widths: [1440, 360], axeViolations: 0, contactRestored, credentialMutations: 0, deliveryClaimed: false }));
} catch { console.error(JSON.stringify({ step, status: "failed" })); process.exitCode = 1; }
finally {
  try { if (restoreContact) await restoreContact(); }
  catch { console.error(JSON.stringify({ step: "restore-contact", status: "failed" })); process.exitCode = 1; }
  await context.close(); await browser.close();
}
