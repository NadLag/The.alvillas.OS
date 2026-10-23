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
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: state, timezoneId: "America/Denver", viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
const page = await context.newPage(), locales = { en, fr, ar };
const checks: Array<{ locale: string; width: number }> = [], hydrationErrors: string[] = [];
const evidence: Record<string, unknown> = { sha, origin, taskId, propertyName, checks, completed: false };
let phase = "authentication";
const checkpoint = () => writeFile(file, JSON.stringify({ ...evidence, phase }, null, 2));
try {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) }).parse(await (await context.request.get("/api/auth/session")).json());
  page.on("pageerror", error => { if (/hydrat|#418/iu.test(error.message)) hydrationErrors.push(error.message); });
  await page.goto(`/en/app/field/${taskId}`);
  await expect(page.getByTestId("field-task-page").getByText(propertyName, { exact: true })).toBeVisible();
  await expect.poll(() => storedFieldData(page, "metadata")).toHaveLength(2); expect(await storedFieldData(page)).toEqual([]);
  const form = page.getByTestId("field-task-complete-form"), items = page.getByTestId("field-checklist-item");
  const total = await items.count(); expect(total).toBeGreaterThan(0);
  for (const item of await items.all()) await expect(item).not.toBeChecked();
  const note = form.getByRole("textbox"), save = form.locator('button[data-progress="true"]');
  const language = page.getByTestId("field-language"), finish = page.getByTestId("field-task-complete");
  const label = (locale: "en" | "fr" | "ar", done: number) => locales[locale].Operations.manage.progress.replace("{done}", String(done)).replace("{total}", String(total));
  phase = "unsaved-work"; await expect(finish).toBeDisabled();
  await items.first().focus(); await page.keyboard.press("Space"); await note.fill("Authenticated field flow acceptance note");
  await language.getByTestId("locale-switch-fr").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("field-language-notice")).toHaveText(en.Field.noteBeforeLanguage);
  await expect(note).toHaveValue("Authenticated field flow acceptance note"); await note.clear();
  await language.getByTestId("locale-switch-fr").click();
  await expect(page.getByTestId("field-language-notice")).toHaveText(en.Field.saveBeforeLanguage);
  phase = "progress-corrections";
  for (const checked of [true, false, true]) {
    await items.first().setChecked(checked); await save.click();
    await expect(form.getByRole("status")).toHaveText(en.Operations.manage.saved);
    await expect(form).not.toHaveAttribute("data-field-dirty", "true");
    if (checked) await expect(items.first()).toBeChecked(); else await expect(items.first()).not.toBeChecked();
    await expect(page.getByTestId("field-checklist-progress")).toHaveText(label("en", checked ? 1 : 0));
  }
  evidence.progressSaves = 3; await checkpoint(); phase = "localized-accessibility";
  for (const locale of ["en", "fr", "ar"] as const) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await language.getByTestId(`locale-switch-${locale}`).focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${locale}/app/field/${taskId}$`, "u"));
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(items.first()).toBeChecked(); await expect(page.getByTestId("field-checklist-progress")).toHaveText(label(locale, 1));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    checks.push({ locale, width });
  }
  await checkpoint(); phase = "offline-completion"; await context.setOffline(true); await expect(save).toBeDisabled();
  await language.getByTestId("locale-switch-en").click();
  await expect(page.getByTestId("field-language-notice")).toHaveText(ar.Field.offlineLanguage);
  for (const item of await items.all()) if (!await item.isChecked()) { await item.focus(); await page.keyboard.press("Space"); }
  await note.fill("Authenticated field flow acceptance: progress corrections, language and offline completion");
  await expect(finish).toBeEnabled(); await finish.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(ar.Field.offlineQueued);
  const queued = await storedFieldData(page); expect(queued).toHaveLength(1); evidence.queued = queued; await checkpoint();
  await context.route("**/api/sync/push", route => route.abort()); await context.setOffline(false);
  await expect(page.getByTestId("field-connection")).not.toContainText(ar.FieldPwa.offline);
  await language.getByTestId("locale-switch-fr").focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/fr/app/field/${taskId}$`, "u"));
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(fr.Field.offlineQueued);
  expect(await storedFieldData(page)).toEqual(queued); await expect(note).toHaveValue("Authenticated field flow acceptance: progress corrections, language and offline completion");
  await expect(page.getByTestId("field-checklist-progress")).toHaveText(label("fr", total));
  await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await context.unroute("**/api/sync/push");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/fr\/app\/field$/u); expect(await storedFieldData(page)).toEqual([]);
  expect(await storedFieldData(page, "metadata")).toHaveLength(2); expect(hydrationErrors).toEqual([]);
  phase = "complete"; evidence.completed = true; evidence.queuedLanguagePreserved = true; evidence.hydrationErrors = 0; await checkpoint();
  console.log(JSON.stringify({ sha, checks: checks.length, progressSaves: 3, queuedLanguagePreserved: true, authenticated: true }));
} catch { await checkpoint(); throw new Error(`Staging field flow stopped at ${phase}; private checkpoint retained`); }
finally { await browser.close(); }
