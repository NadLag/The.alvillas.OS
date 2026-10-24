import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect, request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { storedFieldData } from "../tests/e2e/support/field-storage";
import { syncPushInputSchema } from "../src/modules/reservations/domain/sync-protocol";

const expect = playwrightExpect.configure({ timeout: 30000 });
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE);
const file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const taskId = z.uuid().parse(process.env.STAGING_FIELD_TASK_ID);
const propertyName = z.string().regex(/^Automation acceptance aut-[a-f0-9]{8}$/u).parse(process.env.STAGING_FIELD_PROPERTY_NAME);
const previous = z.object({ photoSaving: z.boolean().optional(), queued: z.unknown().optional(), completed: z.boolean().optional() })
  .parse(JSON.parse(await readFile(file, "utf8")));
if (previous.photoSaving || previous.queued || previous.completed) throw new Error("Verify the recorded photo and operation keys before any replay");
const origin = "https://the-alvillas-os-staging.vercel.app", browser = await chromium.launch();
const context = await browser.newContext({ baseURL: origin, storageState: state, timezoneId: "America/Denver", viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
const page = await context.newPage(), checks: Array<{ locale: string; width: number }> = [], errors: string[] = [];
const evidence: Record<string, unknown> = { sha, origin, taskId, propertyName, checks, completed: false };
const operationRows = z.array(z.object({ deviceId: z.string(), operation: z.object({ client_op_id: z.uuid(), type: z.string(), payload: z.unknown() }) }));
const photoRows = z.array(z.object({ manifest: z.object({ sha256: z.string(), size: z.number(), parts: z.array(z.object({ size: z.number() })) }), uploadedParts: z.array(z.number()) }));
const checkpoint = () => writeFile(file, JSON.stringify({ ...evidence, phase }, null, 2));
let phase = "authentication", releaseParts = false, allowAcknowledgements = false, lost = false;
const wireKeys: string[] = [], note = "Authenticated resumable field photo acceptance";
try {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  const session = z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.literal(false) }) })
    .parse(await (await context.request.get("/api/auth/session")).json());
  evidence.actorId = session.user.id; evidence.organizationId = session.user.organizationId;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/en/app/field/${taskId}`);
  await expect(page.getByTestId("field-task-page")).toContainText(propertyName);
  expect(await storedFieldData(page)).toEqual([]); expect(await storedFieldData(page, "photos")).toEqual([]);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.route("**/api/field/uploads/part?**", async route => {
    try {
      if (!releaseParts && Number(new URL(route.request().url()).searchParams.get("index")) > 0) await route.abort(); else await route.continue();
    } catch { errors.push("photo_part_route_unavailable"); }
  });
  await context.route("**/api/sync/push", async route => {
    try {
    const batch = syncPushInputSchema.parse(route.request().postDataJSON()), operation = batch.ops[0];
    if (operation.type === "field_task.evidence.attach") wireKeys.push(`${batch.device_id}:${operation.client_op_id}`);
    if (!allowAcknowledgements) {
      if (!lost && operation.type === "field_task.evidence.attach") {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        expect(z.object({ results: z.array(z.object({ status: z.literal("APPLIED") })) }).parse(await response.json()).results).toHaveLength(1);
        lost = true;
      }
      await route.abort(); return;
    }
      await route.fulfill({ response: await route.fetch() });
    } catch { errors.push("photo_sync_route_unavailable"); await route.abort().catch(() => undefined); }
  });
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    const context = canvas.getContext("2d")!, data = context.createImageData(1024, 1024); let seed = 1701;
    for (let index = 0; index < data.data.length; index += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      data.data[index] = seed & 255; data.data[index + 1] = (seed >>> 8) & 255; data.data[index + 2] = (seed >>> 16) & 255; data.data[index + 3] = 255;
    }
    context.putImageData(data, 0, 0); return canvas.toDataURL("image/png").split(",")[1];
  });
  const capture = page.getByTestId("field-photo");
  await expect(capture.getByTestId("field-photo-file")).toBeEnabled();
  await capture.getByTestId("field-photo-file").setInputFiles({ name: "field-acceptance.png", mimeType: "image/png", buffer: Buffer.from(encoded, "base64") });
  await capture.getByTestId("field-photo-note").fill(note);
  await page.getByTestId("field-language").getByTestId("locale-switch-fr").click();
  await expect(page).toHaveURL(new RegExp(`/en/app/field/${taskId}$`, "u")); await expect(page.getByTestId("field-language-notice")).toBeVisible();
  for (const checkbox of await page.getByTestId("field-checklist-item").all()) await checkbox.check();
  await page.getByTestId("field-task-complete").click(); await expect(page.getByTestId("field-photo-completion-blocked")).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
  phase = "offline-capture"; await context.setOffline(true); evidence.photoSaving = true; await checkpoint();
  await capture.getByTestId("field-photo-save").click(); await expect(capture.getByTestId("field-photo-queued")).toContainText(note);
  await expect(capture.locator('[data-field-photo-dirty="true"]')).toHaveCount(0);
  const original = operationRows.parse(await storedFieldData(page))[0]; expect(original.operation.type).toBe("field_photo.prepare");
  evidence.queued = original; await checkpoint();
  await page.reload(); await expect(page).toHaveURL(new RegExp(`/en/offline/field\\?task=${taskId}$`, "u"));
  const photo = photoRows.parse(await storedFieldData(page, "photos"))[0]; expect(photo.manifest.parts.length).toBeGreaterThan(1);
  evidence.photo = photo.manifest; phase = "localized-offline-capture";
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByTestId("field-language").getByTestId(`locale-switch-${locale}`).focus(); await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(capture.getByTestId("field-photo-queued")).toContainText(note); expect(operationRows.parse(await storedFieldData(page))[0]).toEqual(original);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks.push({ locale, width });
  }
  await checkpoint(); phase = "partial-transfer"; await context.setOffline(false);
  await expect.poll(async () => photoRows.parse(await storedFieldData(page, "photos"))[0]?.uploadedParts, { timeout: 60000 }).toContain(0);
  const bound = operationRows.parse(await storedFieldData(page))[0]; expect(bound.operation.type).toBe("field_task.evidence.attach");
  expect(bound.deviceId).toBe(original.deviceId); expect(bound.operation.client_op_id).toBe(original.operation.client_op_id); evidence.bound = bound; await checkpoint();
  await context.setOffline(true); await page.reload(); await expect(capture.getByTestId("field-photo-queued")).toContainText(note);
  expect(operationRows.parse(await storedFieldData(page))[0]).toEqual(bound);
  phase = "ordered-completion"; evidence.completionSubmitting = true; await checkpoint();
  await page.getByTestId("field-task-complete").click(); await expect.poll(() => storedFieldData(page)).toHaveLength(2);
  evidence.queuedCompletion = operationRows.parse(await storedFieldData(page))[1]; await checkpoint();
  releaseParts = true; await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  phase = "lost-evidence-acknowledgement"; await expect.poll(() => lost, { timeout: 90000 }).toBe(true);
  expect(operationRows.parse(await storedFieldData(page))[0]).toEqual(bound); evidence.appliedAcknowledgementLost = true; await checkpoint();
  phase = "original-key-retry"; allowAcknowledgements = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/ar\/app\/field$/u, { timeout: 90000 });
  await expect.poll(() => storedFieldData(page)).toEqual([]); expect(await storedFieldData(page, "photos")).toEqual([]);
  expect(wireKeys.length).toBeGreaterThanOrEqual(2); expect(new Set(wireKeys)).toEqual(new Set([`${original.deviceId}:${original.operation.client_op_id}`]));
  phase = "private-photo-download"; await page.goto(`/en/app/field/${taskId}`);
  const row = page.getByTestId("task-evidence-panel").getByRole("listitem").filter({ hasText: note }); await expect(row).toBeVisible();
  const evidenceHref = await row.getByRole("link").getAttribute("href"); expect(evidenceHref).toMatch(/^\/api\/operations\/evidence\/[a-f0-9-]{36}$/u);
  const download = await context.request.get(evidenceHref!); expect(download.status()).toBe(200); expect(download.headers()["cache-control"]).toBe("private, no-store");
  expect(createHash("sha256").update(await download.body()).digest("hex")).toBe(photo.manifest.sha256);
  const anonymous = await request.newContext({ baseURL: origin }); try { expect((await anonymous.get(evidenceHref!)).status()).toBe(401); } finally { await anonymous.dispose(); }
  expect(errors).toEqual([]); expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  evidence.evidenceId = evidenceHref!.split("/").at(-1); evidence.completed = true; evidence.authenticated = true; phase = "complete"; await checkpoint();
  console.log(JSON.stringify({ sha, authenticatedResumablePhoto: true, localizedLayouts: checks.length, safeDuplicateRetry: true, privateDigestVerified: true }));
} catch { await checkpoint(); throw new Error(`Staging photo acceptance incomplete at ${phase}; preserve the private checkpoint and original keys`); }
finally { await browser.close(); }
