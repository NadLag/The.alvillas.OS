import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";

const expect = playwrightExpect.configure({ timeout: 30000 });
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE), file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const fixtureFile = z.string().min(1).parse(process.env.STAGING_OPERATIONS_FIXTURE_FILE);
const fixture = z.object({ taskId: z.uuid(), organizationId: z.uuid(), actorId: z.uuid(), actorPersonId: z.uuid(), workerPersonId: z.uuid(),
  propertyName: z.string().regex(/^(?:Operations acceptance ops-[a-z0-9]+|Automation acceptance aut-[a-f0-9]{8})$/u) })
  .parse(JSON.parse(await readFile(fixtureFile, "utf8")));
const previous = JSON.parse(await readFile(file, "utf8")) as { submitted?: boolean; attachmentSubmitted?: boolean; completed?: boolean };
if (previous.submitted || previous.attachmentSubmitted || previous.completed) throw new Error("Preserve the existing acceptance keys and verify recorded results before any replay");
const origin = "https://the-alvillas-os-staging.vercel.app", browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: state, timezoneId: "America/Denver", viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
const page = await context.newPage(), checks: Array<{ locale: string; width: number }> = [], completedChecks: typeof checks = [], errors: string[] = [];
const evidence: Record<string, unknown> = { sha, origin, ...fixture, checks, completedChecks, completed: false };
let phase = "authentication";
const checkpoint = () => writeFile(file, JSON.stringify({ ...evidence, phase }, null, 2));
try {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  expect(await (await context.request.get("/api/auth/session")).json()).toMatchObject({ user: { id: fixture.actorId, personId: fixture.actorPersonId,
    organizationId: fixture.organizationId, securitySetupRequired: false } });
  expect(fixture.workerPersonId).not.toBe(fixture.actorPersonId); page.on("pageerror", error => errors.push(error.message));
  phase = "localized-confirmation";
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`/${locale}/app/field/validate/${fixture.taskId}`);
    await expect(page.getByTestId("field-proxy-page")).toContainText(fixture.propertyName);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const first = page.getByTestId("field-proxy-form").getByRole("checkbox").first(); await first.focus(); await page.keyboard.press("Space"); await expect(first).toBeChecked();
    await page.keyboard.press("Space"); await expect(first).not.toBeChecked(); await expect(page.getByTestId("field-proxy-submit")).toBeDisabled();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    checks.push({ locale, width });
  }
  await checkpoint(); phase = "private-evidence";
  await page.goto(`/en/app/field/validate/${fixture.taskId}`); await page.getByTestId("field-proxy-evidence").locator("summary").click();
  const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1EAAAAASUVORK5CYII=", "base64");
  const note = "Authenticated staging supervisor evidence", attachment = page.getByTestId("operation-evidence-form");
  await attachment.locator('[name="file"]').setInputFiles({ name: "supervisor-acceptance.png", mimeType: "image/png", buffer: photo });
  await attachment.locator('[name="reason"]').fill(note); evidence.attachmentKey = await attachment.locator('[name="idempotencyKey"]').inputValue();
  evidence.attachmentSubmitted = true; await checkpoint(); await attachment.locator('button[type="submit"]').click();
  const row = page.getByTestId("field-proxy-evidence").getByRole("listitem").filter({ hasText: note }); await expect(row).toBeVisible();
  const href = await row.getByRole("link").getAttribute("href"); expect(href).toMatch(/^\/api\/operations\/evidence\/[a-f0-9-]{36}$/u);
  const downloaded = await context.request.get(href!); expect(downloaded.status()).toBe(200); expect(downloaded.headers()["cache-control"]).toContain("no-store");
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"); expect(digest(await downloaded.body())).toBe(digest(photo));
  const anonymous = await request.newContext({ baseURL: origin }); try { expect((await anonymous.get(href!)).status()).toBe(401); } finally { await anonymous.dispose(); }
  evidence.privatePhoto = { authenticated: true, anonymousDenied: true, digest: digest(photo), evidenceId: href!.split("/").at(-1) }; await checkpoint();
  phase = "proxy-validation";
  const form = page.getByTestId("field-proxy-form"); for (const item of await form.getByRole("checkbox").all()) { await item.focus(); await page.keyboard.press("Space"); }
  await form.locator('[name="reason"]').fill("Staging acceptance confirms work remains attributed to the colleague");
  evidence.operationKey = await form.locator('[name="idempotencyKey"]').inputValue(); evidence.submitted = true; await checkpoint();
  await page.getByTestId("field-proxy-submit").focus(); await page.keyboard.press("Enter"); await expect(page.getByTestId("field-proxy-completed")).toBeVisible();
  phase = "recorded-attribution";
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`/${locale}/app/field/validate/${fixture.taskId}`);
    await expect(page.getByTestId("field-proxy-completed")).toBeVisible(); await expect(page.getByTestId("field-proxy-form")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    completedChecks.push({ locale, width });
  }
  expect(errors).toEqual([]); expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  evidence.completed = true; evidence.authenticated = true; phase = "complete"; await checkpoint();
  console.log(JSON.stringify({ sha, supervisorLayouts: checks.length, recordedLayouts: completedChecks.length, privatePhoto: true, authenticated: true }));
} catch { await checkpoint(); throw new Error(`Staging supervisor acceptance incomplete at ${phase}; preserve the private checkpoint`); }
finally { await browser.close(); }
