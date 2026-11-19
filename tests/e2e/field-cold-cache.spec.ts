import { devices, expect, test } from "@playwright/test";
import { z } from "zod";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";
import en from "../../messages/en.json" with { type: "json" };

test("Field first visit preserves a draft through a cold offline reload", async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for cold field cache"); test.setTimeout(240000);
  const mobile = info.project.name === "field-mobile";
  const measureLowEnd = mobile && process.env.ALVILLAS_LOW_END_ANDROID === "1";
  if (measureLowEnd && process.env.PLAYWRIGHT_PRODUCTION !== "1") {
    throw new Error("The low-end Android check requires a production build");
  }
  const f = await openFieldFixture(page, info, "en", { checklistItems: 2 });
  const cold = await browser.newContext({
    ...(measureLowEnd ? devices["Pixel 5"] : {}),
    storageState: await page.context().storageState(),
    viewport: { width: mobile ? 360 : 1440, height: 1000 }
  });
  await cold.addInitScript(() => {
    const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    let release: (() => void) | undefined; const delayed = new Promise<void>(resolve => { release = resolve; });
    (window as Window & { releaseFieldWorker?: () => void }).releaseFieldWorker = () => release!();
    navigator.serviceWorker.register = (...args) => delayed.then(() => original(...args));
  });
  try {
    const first = await cold.newPage();
    if (measureLowEnd) {
      const devTools = await cold.newCDPSession(first);
      await devTools.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    await first.goto(`/en/app/field/${f.taskId}`);
    await expect.poll(() => storedFieldData(first, "jobs")).toHaveLength(1);
    const form = first.getByTestId("field-task-complete-form"), note = form.locator('textarea[name="note"]');
    await first.getByTestId("field-checklist-item").first().check(); await note.fill("Cold first-visit draft remains available offline");
    await expect.poll(async () => z.array(z.object({ note: z.string() })).parse(await storedFieldData(first, "drafts"))[0]?.note).toBe("Cold first-visit draft remains available offline");
    expect(await first.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
    await first.evaluate(() => (window as Window & { releaseFieldWorker?: () => void }).releaseFieldWorker!());
    await expect.poll(() => first.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect.poll(() => first.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(locale => caches.match(`/${locale}/offline/field`)))).every(Boolean))).toBe(true);
    await cold.setOffline(true);
    const coldStart = performance.now();
    await first.reload({ waitUntil: measureLowEnd ? "domcontentloaded" : "load" });
    await expect(first).toHaveURL(new RegExp(`/en/offline/field\\?task=${f.taskId}$`, "u"));
    await expect(note).toHaveValue("Cold first-visit draft remains available offline"); await expect(first.getByTestId("field-checklist-item").first()).toBeChecked();
    if (measureLowEnd) {
      const coldStartMs = Math.round(performance.now() - coldStart);
      await info.attach("offline cold start", { body: JSON.stringify({ coldStartMs, viewportWidth: 360, cpuSlowdown: 4 }), contentType: "application/json" });
      expect(coldStartMs).toBeLessThan(3_000);
      const controls = await form.locator("label.field-checklist-item, [data-testid=field-task-complete]")
        .evaluateAll((items) => items.map((item) => {
          const { width, height } = item.getBoundingClientRect();
          return Math.min(width, height);
        }));
      expect(controls).toHaveLength(3);
      expect(Math.min(...controls)).toBeGreaterThanOrEqual(48);
    }
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
