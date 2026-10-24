import { expect, test } from "@playwright/test";
import { z } from "zod";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";
import en from "../../messages/en.json" with { type: "json" };

test("Field first visit preserves a draft through a cold offline reload", async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for cold field cache"); test.setTimeout(240000);
  const f = await openFieldFixture(page, info, "en", { checklistItems: 2 });
  const cold = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: info.project.name === "field-mobile" ? 360 : 1440, height: 1000 } });
  await cold.addInitScript(() => {
    const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    let release: (() => void) | undefined; const delayed = new Promise<void>(resolve => { release = resolve; });
    (window as Window & { releaseFieldWorker?: () => void }).releaseFieldWorker = () => release!();
    navigator.serviceWorker.register = (...args) => delayed.then(() => original(...args));
  });
  try {
    const first = await cold.newPage(); await first.goto(`/en/app/field/${f.taskId}`);
    await expect.poll(() => storedFieldData(first, "jobs")).toHaveLength(1);
    const form = first.getByTestId("field-task-complete-form"), note = form.locator('textarea[name="note"]');
    await first.getByTestId("field-checklist-item").first().check(); await note.fill("Cold first-visit draft remains available offline");
    await expect.poll(async () => z.array(z.object({ note: z.string() })).parse(await storedFieldData(first, "drafts"))[0]?.note).toBe("Cold first-visit draft remains available offline");
    expect(await first.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
    await first.evaluate(() => (window as Window & { releaseFieldWorker?: () => void }).releaseFieldWorker!());
    await expect.poll(() => first.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect.poll(() => first.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(locale => caches.match(`/${locale}/offline/field`)))).every(Boolean))).toBe(true);
    await cold.setOffline(true); await first.reload(); await expect(first).toHaveURL(new RegExp(`/en/offline/field\\?task=${f.taskId}$`, "u"));
    await expect(note).toHaveValue("Cold first-visit draft remains available offline"); await expect(first.getByTestId("field-checklist-item").first()).toBeChecked();
    await expect(first.getByTestId("field-task-complete")).toBeDisabled(); await expect(first.getByTestId("field-task-sync-status")).toHaveCount(0);
    await expect(first.getByTestId("field-pwa-notice")).toHaveCount(0); await expect(first.getByTestId("field-cache-status")).not.toHaveText(en.FieldCache.notPrepared);
    expect(await storedFieldData(first)).toEqual([]);
    for (const check of await first.getByTestId("field-checklist-item").all()) if (!await check.isChecked()) await check.check();
    await first.getByTestId("field-task-complete").click(); await expect(first.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
    const queued = await storedFieldData(first); expect(queued).toHaveLength(1);
    await first.reload(); await expect(first.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
    await expect(note).toHaveValue("Cold first-visit draft remains available offline"); expect(await storedFieldData(first)).toEqual(queued);
  } finally { await cold.close(); await f.db.$disconnect(); }
});
