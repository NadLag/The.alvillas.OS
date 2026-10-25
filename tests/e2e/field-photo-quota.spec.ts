import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import ar from "../../messages/ar.json";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData, storedFieldPhotoDigests } from "./support/field-storage";

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
const catalogs = { en, fr, ar };
const draftContents = (rows: unknown[]) => z.array(z.record(z.string(), z.unknown())).parse(rows)
  .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "savedAt")));
const photoContents = (rows: unknown[]) => z.array(z.record(z.string(), z.unknown())).parse(rows)
  .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "attempts" && key !== "retryAt")));

for (const locale of ["en", "fr", "ar"] as const) test(`Native quota abort retains field photos and selected work in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for native quota acceptance"); test.setTimeout(180000);
  const f = await openFieldFixture(page, info, locale), origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  try {
    await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
    await page.getByTestId("field-task-complete-form").locator('textarea[name="note"]').fill("Retain this assigned work under native storage pressure");
    await page.getByTestId("field-checklist-item").check(); await expect(page.getByTestId("field-draft-saved")).toBeVisible();
    const pixels = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d")!; context.fillStyle = "#408060"; context.fillRect(0, 0, 64, 64); return canvas.toDataURL("image/png").split(",")[1]; });
    const capture = page.getByTestId("field-photo"), input = { name: "retained.png", mimeType: "image/png", buffer: Buffer.from(pixels, "base64") };
    await page.context().setOffline(true); await capture.getByTestId("field-photo-file").setInputFiles(input);
    await capture.getByTestId("field-photo-note").fill("Original queued photo"); await capture.getByTestId("field-photo-save").click();
    await expect(capture.getByTestId("field-photo-queued")).toHaveCount(1); await page.reload();
    const original = { queue: await storedFieldData(page), photos: photoContents(await storedFieldData(page, "photos")),
      drafts: draftContents(await storedFieldData(page, "drafts")), digests: await storedFieldPhotoDigests(page) };
    expect(original.queue).toHaveLength(1); expect(original.digests).toHaveLength(1); expect(original.digests[0].actual).toBe(original.digests[0].expected);
    await capture.getByTestId("field-photo-file").setInputFiles(input); await capture.getByTestId("field-photo-note").fill("Keep this selected photo until storage is available");
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    expect(await cdp.send("Storage.getUsageAndQuota", { origin })).toMatchObject({ overrideActive: true, quota: 1 });
    // Chromium caches previously allotted IndexedDB space for thirty seconds.
    // Let that native cache expire; no application storage APIs are replaced.
    await page.waitForTimeout(31000);
    await capture.getByTestId("field-photo-save").click();
    await expect(capture.getByTestId("field-photo-notice")).toHaveText(catalogs[locale].FieldPhoto.storage);
    await expect(capture.getByTestId("field-photo-notice")).toHaveAttribute("role", "alert");
    expect(await storedFieldData(page)).toEqual(original.queue); expect(photoContents(await storedFieldData(page, "photos"))).toEqual(original.photos);
    expect(draftContents(await storedFieldData(page, "drafts"))).toEqual(original.drafts); expect(await storedFieldPhotoDigests(page)).toEqual(original.digests);
    expect(await capture.getByTestId("field-photo-file").evaluate(element => (element as HTMLInputElement).files?.length)).toBe(1);
    await expect(capture.getByTestId("field-photo-note")).toHaveValue("Keep this selected photo until storage is available");
    await expect(page.getByTestId("field-checklist-item")).toBeEnabled(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.syncOp.count({ where: { payload: { path: ["taskId"], equals: f.taskId } } })).toBe(0);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.taskId } })).toBe(0);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).state).toBe("ASSIGNED");
    });
    await cdp.send("Storage.overrideQuotaForOrigin", { origin });
    await capture.getByRole("button", { name: catalogs[locale].FieldPhoto.discard, exact: true }).click(); await page.reload();
    expect(await storedFieldData(page)).toEqual(original.queue); expect(await storedFieldPhotoDigests(page)).toEqual(original.digests);
  } finally { await cdp.send("Storage.overrideQuotaForOrigin", { origin }).catch(() => undefined); await f.db.$disconnect(); }
});
