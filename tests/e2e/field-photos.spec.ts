import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
const photoRows = z.array(z.object({ manifest: z.object({ localId: z.uuid(), sha256: z.string(), parts: z.array(z.object({ size: z.number() })) }),
  uploadedParts: z.array(z.number()), ready: z.boolean() }));
const queuedRows = z.array(z.object({ deviceId: z.string(), operation: z.object({ client_op_id: z.uuid(), type: z.string(), payload: z.unknown() }) }));

for (const locale of ["en", "fr", "ar"]) test(`Field photos survive cold reload and partial transfer before one ordered completion in ${locale}`, async ({ page, playwright }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for field photo acceptance"); test.setTimeout(300000);
  const f = await openFieldFixture(page, info, locale, { checklistItems: 3 });
  const anonymous = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  let releaseParts = false, allowAcknowledgements = false, firstEvidenceApplied = false;
  const wireKeys: string[] = [];
  try {
    await page.context().route("**/api/field/uploads/part?**", route => {
      if (!releaseParts && Number(new URL(route.request().url()).searchParams.get("index")) > 0) return route.abort();
      return route.continue();
    });
    await page.context().route("**/api/sync/push", async route => {
      const body: unknown = route.request().postDataJSON(), batch = syncPushInputSchema.parse(body), operation = batch.ops[0];
      if (operation.type === "field_task.evidence.attach") wireKeys.push(`${batch.device_id}:${operation.client_op_id}`);
      if (!allowAcknowledgements) {
        if (!firstEvidenceApplied && operation.type === "field_task.evidence.attach") { firstEvidenceApplied = true; await route.fetch(); }
        await route.abort(); return;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    const pixels = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
      const context = canvas.getContext("2d")!, data = context.createImageData(1024, 1024); let seed = 1701;
      for (let index = 0; index < data.data.length; index += 4) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        data.data[index] = seed & 255; data.data[index + 1] = (seed >>> 8) & 255; data.data[index + 2] = (seed >>> 16) & 255; data.data[index + 3] = 255;
      }
      context.putImageData(data, 0, 0);
      const value = canvas.toDataURL("image/png").split(",")[1]; if (!value) throw Error("Photo fixture encoding failed"); return value;
    });
    const capture = page.getByTestId("field-photo"), note = `Private field photo acceptance ${locale}`;
    await expect(capture.getByTestId("field-photo-file")).toBeEnabled();
    await capture.getByTestId("field-photo-file").setInputFiles({ name: "inspection.png", mimeType: "image/png", buffer: Buffer.from(pixels, "base64") });
    await capture.getByTestId("field-photo-note").fill(note);
    const nextLocale = locale === "en" ? "fr" : "en";
    await page.getByTestId("field-language").getByTestId(`locale-switch-${nextLocale}`).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/app/field/${f.taskId}$`, "u"));
    await expect(page.getByTestId("field-language-notice")).toBeVisible();
    for (const checkbox of await page.getByTestId("field-checklist-item").all()) await checkbox.check();
    await page.getByTestId("field-task-complete").click(); await expect(page.getByTestId("field-photo-completion-blocked")).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
    await page.context().setOffline(true); await capture.getByTestId("field-photo-save").click();
    await expect(capture.getByTestId("field-photo-queued")).toContainText(note);
    await expect(capture.locator('[data-field-photo-dirty="true"]')).toHaveCount(0);
    const original = queuedRows.parse(await storedFieldData(page))[0]; expect(original.operation.type).toBe("field_photo.prepare");
    await page.reload(); await expect(page).toHaveURL(new RegExp(`/${locale}/offline/field\\?task=${f.taskId}$`, "u"));
    await expect(capture.getByTestId("field-photo-queued")).toContainText(note);
    const stored = photoRows.parse(await storedFieldData(page, "photos"))[0]; expect(stored.manifest.parts.length).toBeGreaterThan(1);
    expect(stored.manifest.localId).toBe(original.operation.client_op_id);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.context().setOffline(false);
    await expect.poll(async () => photoRows.parse(await storedFieldData(page, "photos"))[0]?.uploadedParts).toContain(0);
    const bound = queuedRows.parse(await storedFieldData(page))[0]; expect(bound.operation.type).toBe("field_task.evidence.attach");
    expect(bound.deviceId).toBe(original.deviceId); expect(bound.operation.client_op_id).toBe(original.operation.client_op_id);
    await page.context().setOffline(true); await page.reload();
    await expect(capture.getByTestId("field-photo-queued")).toContainText(note);
    expect(queuedRows.parse(await storedFieldData(page))[0]).toEqual(bound);
    await page.getByTestId("field-task-complete").click(); await expect.poll(() => storedFieldData(page)).toHaveLength(2);
    releaseParts = true; await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.operationTaskEvidence.count({ where: { taskId: f.taskId } })), { timeout: 60000 }).toBe(1);
    expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.complete" } }))).toBe(0);
    expect(queuedRows.parse(await storedFieldData(page))[0]).toEqual(bound);
    allowAcknowledgements = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"), { timeout: 60000 });
    await expect.poll(() => storedFieldData(page)).toEqual([]); expect(await storedFieldData(page, "photos")).toEqual([]);
    expect(wireKeys.length).toBeGreaterThanOrEqual(2); expect(new Set(wireKeys)).toEqual(new Set([`${original.deviceId}:${original.operation.client_op_id}`]));
    const evidence = await withTenant(f.db, f.organizationId, async tx => {
      const records = await tx.operationTaskEvidence.findMany({ where: { taskId: f.taskId } }); expect(records).toHaveLength(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.evidence.attached" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.complete" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(1);
      expect(await tx.syncOp.count({ where: { clientOpId: original.operation.client_op_id, deviceId: original.deviceId, status: "APPLIED" } })).toBe(1);
      return records[0];
    });
    const download = await page.request.get(`/api/operations/evidence/${evidence.id}`);
    expect(download.status()).toBe(200); expect(download.headers()["cache-control"]).toBe("private, no-store");
    expect(createHash("sha256").update(await download.body()).digest("hex")).toBe(stored.manifest.sha256);
    expect((await anonymous.get(`/api/operations/evidence/${evidence.id}`)).status()).toBe(401);
  } finally { await page.context().setOffline(false); await anonymous.dispose(); await f.db.$disconnect(); }
});
