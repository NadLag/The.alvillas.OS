import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect as playwrightExpect, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import en from "../messages/en.json" with { type: "json" };
import { storedFieldData } from "../tests/e2e/support/field-storage";

const expect = playwrightExpect.configure({ timeout: 30000 });
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const taskId = z.uuid().parse(process.env.STAGING_FIELD_TASK_ID);
const backgroundTaskId = z.uuid().parse(process.env.STAGING_BACKGROUND_TASK_ID);
const propertyName = z.string().regex(/^Automation acceptance aut-[a-f0-9]{8}$/u).parse(process.env.STAGING_FIELD_PROPERTY_NAME);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE);
const profile = z.string().min(1).parse(process.env.STAGING_PROFILE_DIRECTORY);
const evidenceFile = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const profilePath = await realpath(profile), privateParent = await realpath(dirname(state));
if (taskId === backgroundTaskId || dirname(profilePath) !== privateParent || !/^staging-field-pwa-[a-z0-9-]+$/u.test(basename(profilePath)) || (await readdir(profilePath)).length) {
  throw new Error("Two labeled tasks and a new private acceptance profile are required");
}
const origin = "https://the-alvillas-os-staging.vercel.app";
const saved = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) })) }).parse(JSON.parse(await readFile(state, "utf8")));
const context = await chromium.launchPersistentContext(profilePath, { headless: true, channel: "chromium", baseURL: origin,
  ignoreDefaultArgs: ["--disable-background-networking"], viewport: { width: 1440, height: 1000 }, timezoneId: "America/Denver" });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
const page = context.pages()[0] ?? await context.newPage();
const checks: Array<{ locale: string; width: number }> = [], hydrationErrors: string[] = [];
const evidence: Record<string, unknown> = { sha, origin, taskId, backgroundTaskId, propertyName, checks, completed: false };
let completed = false, phase = "authentication";
const checkpoint = () => writeFile(evidenceFile, JSON.stringify({ ...evidence, phase }, null, 2));
try {
  await context.addCookies(saved.cookies.filter(cookie => cookie.domain.replace(/^\./u, "") === new URL(origin).hostname));
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, commitRef: "main", environment: "preview" });
  z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) }).parse(await (await context.request.get("/api/auth/session")).json());
  page.on("pageerror", error => { if (/hydrat|#418/iu.test(error.message)) hydrationErrors.push(error.message); });
  const cdp = await context.newCDPSession(page); let registrationId: string | undefined;
  cdp.on("ServiceWorker.workerRegistrationUpdated", event => { registrationId = event.registrations.find(item => item.scopeURL === origin + "/")?.registrationId ?? registrationId; });
  await cdp.send("ServiceWorker.enable");
  phase = "localized-installability";
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/${locale}/app/field/${taskId}`);
    await expect(page.getByTestId("field-task-page").getByText(propertyName, { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    const manifest = await cdp.send("Page.getAppManifest"); expect(manifest.errors).toEqual([]); expect(manifest.url).toContain(`/${locale}/manifest.webmanifest`);
    await expect.poll(async () => (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    checks.push({ locale, width });
  }
  await checkpoint(); phase = "queued-update";
  await page.goto(`/en/app/field/${taskId}`);
  for (const item of await page.getByTestId("field-checklist-item").all()) if (!await item.isChecked()) { await item.focus(); await page.keyboard.press("Space"); }
  const note = page.getByTestId("field-task-complete-form").getByRole("textbox");
  await note.fill("Authenticated PWA acceptance: queued work survives update and acknowledgement loss");
  await page.evaluate(async suffix => { await navigator.serviceWorker.register(`/sw.js?acceptance=${suffix}`, { scope: "/", updateViaCache: "none" }); }, randomUUID());
  const update = page.getByTestId("field-update"); await expect(update).toBeVisible(); await update.click();
  await expect(page.getByTestId("field-pwa-notice")).toHaveText(en.FieldPwa.saveBeforeUpdate);
  await context.setOffline(true); await page.getByTestId("field-task-complete").click();
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued); await expect(update).toBeDisabled();
  const queued = await storedFieldData(page); expect(queued).toHaveLength(1); evidence.queued = queued; await checkpoint();
  const blockSync = (route: Route) => route.abort();
  await context.route("**/api/sync/push", blockSync); await context.setOffline(false); await expect(update).toBeEnabled();
  const loaded = page.waitForEvent("load"); await update.click(); await loaded;
  await expect(note).toHaveValue("Authenticated PWA acceptance: queued work survives update and acknowledgement loss");
  expect(await storedFieldData(page)).toEqual(queued); await expect(page.getByTestId("field-sync-now")).toBeEnabled();
  evidence.updatePreservedQueue = true; await checkpoint(); phase = "lost-acknowledgement";
  let applied = false;
  await context.route("**/api/sync/push", async route => {
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    const result = z.object({ results: z.array(z.object({ client_op_id: z.uuid(), status: z.enum(["APPLIED", "DUPLICATE"]) })) }).parse(await response.json());
    if (result.results[0]?.status === "APPLIED") { evidence.firstResult = result; applied = true; await checkpoint(); }
    await route.abort();
  });
  await context.unroute("**/api/sync/push", blockSync);
  await page.getByTestId("field-sync-now").click(); await expect.poll(() => applied).toBe(true);
  await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued); expect(await storedFieldData(page)).toEqual(queued);
  await expect(page.getByTestId("field-sync-now")).toBeEnabled();
  await context.unroute("**/api/sync/push"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/en\/app\/field$/u); expect(await storedFieldData(page)).toEqual([]);
  expect(await storedFieldData(page, "metadata")).toHaveLength(2); evidence.lostAcknowledgementRetried = true; await checkpoint();
  phase = "native-background-sync";
  await page.goto(`/en/app/field/${backgroundTaskId}`); await expect(page.getByTestId("field-task-page").getByText(propertyName, { exact: true })).toBeVisible();
  for (const item of await page.getByTestId("field-checklist-item").all()) if (!await item.isChecked()) { await item.focus(); await page.keyboard.press("Space"); }
  await context.setOffline(true); await page.getByTestId("field-task-complete").click(); await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
  evidence.backgroundQueued = await storedFieldData(page); await checkpoint();
  await expect.poll(() => page.evaluate(async () => {
    const registration: ServiceWorkerRegistration & { sync?: { getTags(): Promise<string[]> } } = await navigator.serviceWorker.ready;
    return await registration.sync?.getTags() ?? [];
  })).toContain("alvillas-field-queue");
  await expect.poll(() => registrationId).toBeTruthy();
  const accepted = context.waitForEvent("response", response => response.url().endsWith("/api/sync/push") && response.status() === 200);
  await page.goto("about:blank"); await context.setOffline(false);
  await cdp.send("ServiceWorker.dispatchSyncEvent", { origin, registrationId: registrationId!, tag: "alvillas-field-queue", lastChance: false });
  await cdp.send("ServiceWorker.dispatchSyncEvent", { origin, registrationId: registrationId!, tag: "alvillas-field-queue", lastChance: false });
  await accepted;
  await page.goto(`/en/app/operations/${backgroundTaskId}`);
  await expect(page.getByTestId("operation-detail-page").locator("header").first().getByText(en.Operations.manage.states.COMPLETED, { exact: false })).toBeVisible();
  await expect.poll(() => storedFieldData(page)).toEqual([]); expect(await storedFieldData(page, "metadata")).toHaveLength(2);
  evidence.backgroundCompletedWithTaskPageClosed = true; expect(hydrationErrors).toEqual([]); evidence.hydrationErrors = 0;
  phase = "complete"; completed = true; evidence.completed = true; await checkpoint();
  console.log(JSON.stringify({ sha, checks: checks.length, updatePreservedQueue: true, lostAcknowledgementRetried: true, backgroundCompletedWithTaskPageClosed: true }));
} catch { await checkpoint(); throw new Error(`Staging PWA acceptance stopped at ${phase}; private checkpoint and profile retained`); }
finally {
  await context.close();
  if (completed) {
    const absolute = await realpath(profilePath);
    if (dirname(absolute) === privateParent && /^staging-field-pwa-[a-z0-9-]+$/u.test(basename(absolute))) await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
