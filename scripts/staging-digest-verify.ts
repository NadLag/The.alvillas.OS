import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const expectedSha = process.env.STAGING_EXPECTED_SHA;
const stateFile = process.env.STAGING_STORAGE_STATE_FILE;
if (!expectedSha || !stateFile) throw new Error("Existing staging authentication and expected SHA are required");
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: stateFile });
context.setDefaultTimeout(30000);
const page = await context.newPage();
let step = "version";
type Choices = { frequency: string; language: string; time: string; timezone: string; weekday: string; quiet: boolean; start: string; end: string; email: boolean[] };
let original: Choices | undefined; let restored = false;
const fields = ["language", "time", "timezone"] as const;
async function capture(): Promise<Choices> {
  const quiet = await page.getByTestId("digest-quiet-enabled").isChecked();
  return { frequency: await page.getByTestId("digest-frequency").inputValue(), language: await page.getByTestId("digest-language").inputValue(),
    time: await page.getByTestId("digest-time").inputValue(), timezone: await page.getByTestId("digest-timezone").inputValue(),
    weekday: await page.getByTestId("digest-weekday").count() ? await page.getByTestId("digest-weekday").inputValue() : "1", quiet,
    start: quiet ? await page.getByTestId("digest-quiet-start").inputValue() : "", end: quiet ? await page.getByTestId("digest-quiet-end").inputValue() : "",
    email: await Promise.all(["enabled", "account", "operations"].map((key) => page.getByTestId(`notification-email-${key}`).isChecked())) };
}
async function persist() {
  const save = page.getByTestId("digest-save");
  if (await save.isEnabled()) { await save.click(); await expect(page.getByTestId("digest-settings").locator('[role="status"][aria-live="polite"]')).toHaveText("Your digest settings have been saved."); }
}
async function restore() {
  if (!original) return;
  await page.goto("/en/app/notifications"); await expect(page.getByTestId("digest-frequency")).toBeVisible();
  await page.getByTestId("digest-frequency").selectOption("weekly");
  await page.getByTestId("digest-weekday").selectOption(original.weekday);
  await page.getByTestId("digest-frequency").selectOption(original.frequency);
  for (const field of fields) {
    const control = page.getByTestId(`digest-${field}`);
    if (field === "language") await control.selectOption(original[field]); else await control.fill(original[field]);
  }
  if (original.frequency === "weekly") await page.getByTestId("digest-weekday").selectOption(original.weekday);
  await page.getByTestId("digest-quiet-enabled").setChecked(original.quiet);
  if (original.quiet) { await page.getByTestId("digest-quiet-start").fill(original.start); await page.getByTestId("digest-quiet-end").fill(original.end); }
  await persist();
  for (const [index, key] of ["enabled", "account", "operations"].entries()) await page.getByTestId(`notification-email-${key}`).setChecked(original.email[index]);
  const save = page.getByTestId("notification-preferences-save"); if (await save.isEnabled()) { await save.click(); await expect(save).toBeDisabled(); }
  await page.reload(); const current = await capture();
  expect(current).toEqual(original); restored = true;
}
try {
  expect(await (await page.goto("/api/version"))?.json()).toMatchObject({ version: expectedSha, commitRef: "main", environment: "preview" });
  step = "existing-authentication";
  const session = await (await page.goto("/api/auth/session"))?.json() as { user?: { id?: string; securitySetupRequired?: boolean } };
  if (!session.user?.id || session.user.securitySetupRequired) throw new Error("An existing enrolled staging sign-in is required");
  await page.goto("/en/app/notifications"); await expect(page.getByTestId("digest-frequency")).toBeVisible(); original = await capture();
  // Choose next week's schedule so UI verification cannot trigger a delivery.
  await page.getByTestId("digest-frequency").selectOption("weekly"); await page.getByTestId("digest-weekday").selectOption(String((new Date().getUTCDay() + 6) % 7));
  await page.getByTestId("digest-language").selectOption("fr"); await page.getByTestId("digest-time").fill("09:30"); await page.getByTestId("digest-timezone").fill("UTC"); await persist();
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const locale of ["en", "fr", "ar"]) {
      step = `digest-localization-${locale}-${width}`;
      await page.goto(`/${locale}/app/notifications`);
      await expect(page.getByTestId("digest-frequency")).toHaveValue("weekly"); await expect(page.getByTestId("digest-language")).toHaveValue("fr");
      await expect(page.getByTestId("digest-timezone")).toHaveValue("UTC");
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(await page.evaluate((value) => document.documentElement.scrollWidth <= value, width)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  }
  step = "restore-preferences"; await restore();
  step = "anonymous-email-link";
  const anonymous = await browser.newContext({ baseURL: origin });
  try { const target = await anonymous.newPage(); await target.goto(`/en/app/notifications/open/${crypto.randomUUID()}`); await expect(target).toHaveURL(/\/en\/login$/u); } finally { await anonymous.close(); }
  step = "unsigned-receipt";
  expect([401, 503]).toContain((await context.request.post("/api/webhooks/resend", { data: {} })).status());
  console.log(JSON.stringify({ settings: "persisted-and-restored", locales: ["en", "fr", "ar"], widths: [1440, 360], axeViolations: 0, authenticated: true,
    anonymousRecordDenied: true, unsignedReceiptDenied: true, liveEmailVerified: false, credentialMutations: 0, productionChanges: 0 }));
} catch { console.error(JSON.stringify({ step, status: "failed", preferencesRestored: restored })); process.exitCode = 1; }
finally {
  if (original && !restored) { try { await restore(); } catch { console.error(JSON.stringify({ step: "restore-preferences", status: "failed" })); process.exitCode = 1; } }
  await context.close(); await browser.close();
}
