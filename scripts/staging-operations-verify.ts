import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const sha = process.env.STAGING_EXPECTED_SHA, state = process.env.STAGING_STORAGE_STATE_FILE;
const fixtureFile = process.env.STAGING_OPERATIONS_FIXTURE_FILE, evidenceFile = process.env.STAGING_EVIDENCE_FILE;
if (!sha || !state || !fixtureFile || !evidenceFile) throw new Error("Staging SHA, authenticated state, Operations fixture and evidence paths are required");
const fixture = z.object({ propertyId: z.uuid(), proxyTaskId: z.uuid(), workerPersonId: z.uuid(), actorPersonId: z.uuid(), actorId: z.uuid(), organizationId: z.uuid(), run: z.string().regex(/^[a-z0-9-]{1,50}$/u) }).parse(JSON.parse(await readFile(fixtureFile, "utf8")));
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: state, viewport: { width: 1440, height: 1000 } });
try {
  const version: unknown = await (await context.request.get("/api/version")).json();
  expect(version).toMatchObject({ version: sha, commitRef: "main", environment: "preview" });
  expect(await (await context.request.get("/api/auth/session")).json()).toMatchObject({ user: { id: fixture.actorId, organizationId: fixture.organizationId, securitySetupRequired: false } });
  const page = await context.newPage();
  await page.goto(`/en/app/operations/new?propertyId=${fixture.propertyId}`);
  const form = page.getByTestId("operation-create-form");
  await form.locator('[name="type"]').selectOption("LAUNDRY");
  await form.locator('[name="titleEn"]').fill(`Laundry ${fixture.run}`); await form.locator('[name="titleFr"]').fill(`Blanchisserie ${fixture.run}`);
  await form.locator('[name="dueDate"]').fill("2027-04-10"); await form.locator('[name="reason"]').fill("Verify staging operational checklist creation");
  await form.locator('button[type="submit"]').click(); await expect(page.getByTestId("operation-detail-page")).toBeVisible();
  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByTestId("task-history-event")).toHaveCount(1);
  await page.goto(`/en/app/operations/${fixture.proxyTaskId}`);
  const proxy = page.getByTestId("operation-proxy-form");
  for (const item of await proxy.locator('[name="checklistItemIds"]').all()) await item.check();
  await proxy.locator('[name="reason"]').fill("Worker could not connect during staging acceptance");
  await proxy.locator('button[type="submit"]').click();
  await expect(page.getByTestId("task-performed-by")).toHaveAttribute("data-person-id", fixture.workerPersonId);
  await expect(page.getByTestId("task-validated-by")).toHaveAttribute("data-person-id", fixture.actorPersonId);
  const checks = [];
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/${locale}/app/operations/${fixture.proxyTaskId}`);
    await expect(page.getByTestId("task-performed-by")).toHaveAttribute("data-person-id", fixture.workerPersonId);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    checks.push({ locale, width, axe: "passed", overflow: false });
  }
  const evidence = { sha, origin, taskId, proxyTaskId: fixture.proxyTaskId, performedBy: fixture.workerPersonId, validatedBy: fixture.actorPersonId, checks };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
