import { writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import en from "../messages/en.json" with { type: "json" };
import fr from "../messages/fr.json" with { type: "json" };
import ar from "../messages/ar.json" with { type: "json" };
import { storedFieldData } from "../tests/e2e/support/field-storage";

const expect = playwrightExpect.configure({ timeout: 30000 });
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const taskId = z.uuid().parse(process.env.STAGING_FIELD_TASK_ID);
const propertyName = z.string().regex(/^Automation acceptance aut-[a-f0-9]{8}$/u).parse(process.env.STAGING_FIELD_PROPERTY_NAME);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE);
const file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const origin = "https://the-alvillas-os-staging.vercel.app";
const browser = await chromium.launch(), context = await browser.newContext({ baseURL: origin, storageState: state, timezoneId: "America/Denver", viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
const page = await context.newPage(), checks: Array<{ locale: string; width: number }> = [], errors: string[] = [];
const catalogs = { en, fr, ar }, noteText = "Authenticated field day cache acceptance: retained offline work and safe completion retry";
const evidence: Record<string, unknown> = { sha, origin, taskId, propertyName, checks, completed: false };
let phase = "authentication";
const checkpoint = () => writeFile(file, JSON.stringify({ ...evidence, phase }, null, 2));
try {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  const session = z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) })
    .parse(await (await context.request.get("/api/auth/session")).json());
  evidence.actorId = session.user.id; evidence.organizationId = session.user.organizationId;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/en/app/field/${taskId}`);
  await expect(page.getByTestId("field-task-page").getByText(propertyName, { exact: true })).toBeVisible();
  await expect.poll(async () => z.array(z.object({ task: z.object({ id: z.uuid() }) })).parse(await storedFieldData(page, "jobs")).some(row => row.task.id === taskId)).toBe(true);
  expect(await storedFieldData(page)).toEqual([]);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const publicHtml = await page.evaluate(async () => {
    const bodies: string[] = [];
    for (const language of ["en", "fr", "ar"]) {
      const response = await caches.match(`/${language}/offline/field`);
      if (!response) throw new Error("Public offline shell not prepared"); bodies.push(await response.text());
    }
    return bodies;
  });
  for (const html of publicHtml) { expect(html).toContain('data-field-offline-shell="public"'); expect(html).not.toContain(propertyName); expect(html).not.toContain(taskId); }
  evidence.anonymousShells = 3;
  const items = page.getByTestId("field-checklist-item"), form = page.getByTestId("field-task-complete-form"), note = form.locator('textarea[name="note"]');
  const total = await items.count(); expect(total).toBeGreaterThan(0);
  for (const item of await items.all()) await expect(item).not.toBeChecked();
  if (total > 1) await items.first().check();
  await note.fill(noteText); await expect(page.getByTestId("field-draft-saved")).toBeVisible();
  await expect.poll(async () => z.array(z.object({ taskId: z.uuid(), note: z.string() })).parse(await storedFieldData(page, "drafts"))
    .some(row => row.taskId === taskId && row.note === noteText)).toBe(true);
  phase = "offline-reload"; await checkpoint(); await context.setOffline(true); await page.reload();
  await expect(page).toHaveURL(new RegExp(`/en/offline/field\\?task=${taskId}$`, "u"));
  phase = "offline-draft-restore";
  await expect(note).toHaveValue(noteText); await expect(page.getByTestId("field-task-complete")).toBeDisabled();
  phase = "localized-accessibility";
  for (const locale of ["en", "fr", "ar"] as const) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId("field-language").getByTestId(`locale-switch-${locale}`).focus(); await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(note).toHaveValue(noteText); if (total > 1) await expect(items.first()).toBeChecked();
    await expect(page.getByTestId("field-task-complete")).toHaveText(catalogs[locale].Field.complete);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload(); await expect(note).toHaveValue(noteText); if (total > 1) await expect(items.first()).toBeChecked();
    checks.push({ locale, width });
  }
  evidence.partialDraftPreserved = true; await checkpoint(); phase = "offline-completion";
  for (const item of await items.all()) if (!await item.isChecked()) { await item.focus(); await page.keyboard.press("Space"); }
  await page.getByTestId("field-task-complete").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(ar.Field.offlineQueued);
  const queued = await storedFieldData(page); expect(queued).toHaveLength(1); evidence.queued = queued; await checkpoint();
  await page.reload(); await expect(page.getByTestId("field-task-sync-status")).toHaveText(ar.Field.offlineQueued); expect(await storedFieldData(page)).toEqual(queued);
  let lost = false; phase = "lost-acknowledgement";
  await context.route("**/api/sync/push", async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200);
    expect(z.object({ results: z.array(z.object({ status: z.literal("APPLIED") })) }).parse(await response.json()).results).toHaveLength(1);
    lost = true; await route.abort();
  });
  await context.setOffline(false); await expect.poll(() => lost).toBe(true); expect(await storedFieldData(page)).toEqual(queued);
  await context.setOffline(true); await page.reload(); expect(await storedFieldData(page)).toEqual(queued); evidence.appliedAcknowledgementLost = true; await checkpoint();
  phase = "duplicate-retry"; await context.unroute("**/api/sync/push"); await context.setOffline(false);
  await expect(page).toHaveURL(/\/ar\/app\/field$/u); await expect.poll(() => storedFieldData(page)).toEqual([]);
  await expect.poll(async () => z.array(z.object({ task: z.object({ id: z.uuid() }) })).parse(await storedFieldData(page, "jobs")).some(row => row.task.id === taskId)).toBe(false);
  expect(z.array(z.object({ taskId: z.uuid() })).parse(await storedFieldData(page, "drafts")).some(row => row.taskId === taskId)).toBe(false);
  expect(errors).toEqual([]); evidence.completed = true; evidence.cachedCompletionRemoved = true; evidence.hydrationErrors = 0;
  phase = "complete"; await checkpoint();
  console.log(JSON.stringify({ sha, authenticatedOfflineCache: true, checks: checks.length, partialDraftPreserved: true, safeDuplicateRetry: true }));
} catch { await checkpoint(); throw new Error(`Staging field cache stopped at ${phase}; private checkpoint retained`); }
finally { await browser.close(); }
