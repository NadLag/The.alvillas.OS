import { writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import en from "../messages/en.json" with { type: "json" };
import { storedFieldData } from "../tests/e2e/support/field-storage";

const expect = playwrightExpect.configure({ timeout: 30000 });
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const taskId = z.uuid().parse(process.env.STAGING_FIELD_TASK_ID);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE);
const evidenceFile = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const origin = "https://the-alvillas-os-staging.vercel.app";
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: state, viewport: { width: 1440, height: 1000 }, timezoneId: "America/Denver" });
context.setDefaultTimeout(30000);
context.setDefaultNavigationTimeout(90000);
const checks: Array<{ locale: string; width: number }> = [], hydrationErrors: string[] = [];
try {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, commitRef: "main", environment: "preview" });
  z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) }).parse(await (await context.request.get("/api/auth/session")).json());
  const page = await context.newPage();
  page.on("pageerror", error => { if (/hydrat|#418/iu.test(error.message)) hydrationErrors.push(error.message); });
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/${locale}/app/field/${taskId}`);
    await expect(page.getByTestId("field-task-complete-form")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    checks.push({ locale, width });
  }
  await page.goto(`/en/app/field/${taskId}`);
  await expect.poll(async () => (await storedFieldData(page, "metadata")).length).toBe(2);
  const checkboxes = page.getByTestId("field-checklist-item");
  for (const item of await checkboxes.all()) if (!await item.isChecked()) { await item.focus(); await page.keyboard.press("Space"); }
  const note = page.getByTestId("field-task-complete-form").getByRole("textbox");
  await note.fill("Authenticated Field queue staging acceptance: retained offline work");
  await context.setOffline(true); await page.getByTestId("field-task-complete").click();
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
  const queued = await storedFieldData(page); expect(queued).toHaveLength(1);
  await page.route("**/api/sync/push", route => route.abort());
  await context.setOffline(false); await page.reload();
  await expect(note).toHaveValue("Authenticated Field queue staging acceptance: retained offline work");
  expect(await storedFieldData(page)).toEqual(queued);
  await page.unroute("**/api/sync/push");
  let committed = false;
  let firstResult: unknown;
  await page.route("**/api/sync/push", async route => {
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    firstResult = await response.json();
    expect(firstResult).toMatchObject({ results: [{ status: "APPLIED" }] });
    await writeFile(evidenceFile, JSON.stringify({ sha, origin, taskId, checks, firstResult, committed: true, completed: false }, null, 2));
    committed = true; await route.abort();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => committed).toBe(true);
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
  expect(await storedFieldData(page)).toEqual(queued);
  await page.unroute("**/api/sync/push");
  const ack = page.waitForResponse(response => response.url().endsWith("/api/sync/push") && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(await (await ack).json()).toMatchObject({ results: [{ status: "DUPLICATE" }] });
  await expect(page).toHaveURL(/\/en\/app\/field$/u);
  expect(await storedFieldData(page)).toEqual([]); expect(hydrationErrors).toEqual([]);
  const evidence = { sha, origin, taskId, checks, firstResult, completed: true, lostAcknowledgementRetried: true, hydrationErrors: 0 };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ sha, checks: checks.length, completed: true, lostAcknowledgementRetried: true }));
} finally { await browser.close(); }
