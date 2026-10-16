import { readFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import en from "../messages/en.json" with { type: "json" };
import fr from "../messages/fr.json" with { type: "json" };
import ar from "../messages/ar.json" with { type: "json" };

const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const sha = process.env.STAGING_EXPECTED_SHA;
const state = process.env.STAGING_STORAGE_STATE_FILE;
const evidenceFile = process.env.STAGING_DELIVERY_EVIDENCE_FILE;
if (!sha || !state || !evidenceFile) throw new Error("STAGING_EXPECTED_SHA, STAGING_STORAGE_STATE_FILE and STAGING_DELIVERY_EVIDENCE_FILE are required");
const evidence = z.array(z.object({ id: z.uuid(), providerId: z.string().min(1), status: z.enum(["DELIVERED", "BOUNCED", "COMPLAINED", "FAILED", "SUPPRESSED"]) })).min(1)
  .parse(JSON.parse(await readFile(evidenceFile, "utf8")) as unknown);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: state });
let step = "version";
try {
  const page = await context.newPage();
  expect(await (await context.request.get("/api/version")).json() as unknown).toMatchObject({ version: sha, commitRef: "main", environment: "preview" });
  step = "existing-authentication";
  const session = await (await context.request.get("/api/auth/session")).json() as { user?: { id?: string; securitySetupRequired?: boolean } };
  if (!session.user?.id || session.user.securitySetupRequired) throw new Error("Existing enrolled administrator session required");
  for (const width of [1440, 360]) for (const locale of ["en", "fr", "ar"] as const) {
    step = `delivery-${locale}-${width}`;
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`/${locale}/app/notifications`);
    const panel = page.getByTestId("delivery-settings"); const labels = { en, fr, ar }[locale].Notifications.delivery;
    await expect(panel.getByTestId("delivery-row").first()).toBeVisible();
    await page.getByTestId("delivery-channel").selectOption("email");
    await expect(panel).toHaveAttribute("aria-busy", "false");
    for (let i = 0; i < 10; i++) {
      if ((await Promise.all(evidence.map(row => panel.locator(`[data-delivery-id="${row.id}"]`).count()))).every(Boolean)) break;
      await page.getByTestId("delivery-more").click(); await expect(panel).toHaveAttribute("aria-busy", "false");
    }
    for (const delivery of evidence) {
      const row = panel.locator(`[data-delivery-id="${delivery.id}"]`);
      await expect(row).toContainText(labels.statuses[delivery.status]); await expect(row).toContainText("••••••");
      await row.getByRole("button", { name: labels.details }).click();
      await expect(row).toContainText(labels.historyNote); await expect(row.getByTestId("delivery-retry")).toHaveCount(0);
      expect(await row.innerText()).not.toContain(delivery.providerId);
    }
    expect(await panel.innerText()).not.toMatch(/@resend\.dev|@example\.|whsec_|re_[A-Za-z0-9]{20}|SMTP 550|activationCode|recoveryCode/u);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  step = "unsigned-receipt";
  expect((await context.request.post("/api/webhooks/resend", { data: {} })).status()).toBe(401);
  step = "anonymous-access";
  const anonymous = await browser.newContext({ baseURL: origin });
  try { const page = await anonymous.newPage(); await page.goto("/en/app/notifications"); await expect(page).toHaveURL(/\/en\/login$/u); await expect(page.getByTestId("delivery-settings")).toHaveCount(0); }
  finally { await anonymous.close(); }
  console.log(JSON.stringify({ authenticated: true, providerDeliveriesVisible: evidence.length, terminalRetriesDenied: true, recipientsMasked: true,
    locales: ["en", "fr", "ar"], widths: [1440, 360], axeViolations: 0, unsignedReceiptDenied: true, anonymousAccessDenied: true, credentialMutations: 0, productionChanges: 0 }));
} catch { console.error(JSON.stringify({ step, status: "failed", credentialMutations: 0 })); process.exitCode = 1; }
finally { await context.close(); await browser.close(); }
