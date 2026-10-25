import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";
import { fieldNetwork } from "./support/field-network";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

const entries = z.array(z.object({ deviceId: z.string(), operation: z.object({ client_op_id: z.uuid(), type: z.string(), payload: z.record(z.string(), z.unknown()) }),
  syncStatus: z.string(), resolvedByClientOpId: z.string().optional() }));
test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Linen counts survive offline reload and require explicit conflict review in ${locale}`, async ({ page, playwright }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for linen counters"); test.setTimeout(300000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Linen fixtures require local PostgreSQL");
  const f = await openFieldFixture(page, info, locale), origin = new URL(page.url()).origin, t = { en, fr, ar }[locale].FieldLinen;
  const remote = await playwright.request.newContext({ baseURL: origin, storageState: await page.context().storageState() });
  const network = await fieldNetwork(page.context(), "unavailable"); let releaseConflictPull: (() => void) | undefined;
  try {
    const user = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await remote.get("/api/auth/session")).json()).user;
    const rule = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      return new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "inventory.minimums", scopeType: "property", scopeId: task.propertyId,
        effectiveFrom: new Date("2020-01-01"), createdBy: user.id, reason: "Explicit field linen counter acceptance", value: { minimums: [{
          item: `linen_${randomUUID().replaceAll("-", "")}`, quantity: 8, category: "LINEN", unit: "pieces",
          name: { en: "Bath towel", fr: "Serviette de bain", ar: "منشفة حمام" } }] } });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const row = page.getByTestId("field-linen-item"), count = row.getByTestId("field-linen-count"), note = row.getByTestId("field-linen-note");
    await expect(row).toHaveCount(1); await expect(count).toHaveValue("0"); await expect(count).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await row.getByTestId("field-linen-increase").boundingBox())!.height).toBeGreaterThanOrEqual(64);
    await row.getByTestId("field-linen-increase").focus(); await page.keyboard.press("Enter"); await expect(count).toHaveValue("1");
    await row.getByTestId("field-linen-decrease").click(); await expect(count).toHaveValue("0");
    await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
    await page.context().setOffline(true);
    await count.fill(locale === "ar" ? "١٢" : "12"); await expect(count).toHaveValue("12");
    const retainedNote = `Physical linen count retained ${locale}`; await note.fill(retainedNote);
    await expect.poll(async () => z.array(z.object({ countedQuantity: z.string(), note: z.string(), clientOpId: z.uuid() })).parse(await storedFieldData(page, "linenDrafts"))[0]?.note).toBe(retainedNote);
    const originalDraft = z.array(z.object({ clientOpId: z.uuid() })).parse(await storedFieldData(page, "linenDrafts"))[0];
    await page.reload(); await expect(page).toHaveURL(new RegExp(`/${locale}/offline/field\\?task=${f.taskId}$`, "u"));
    await expect(count).toHaveValue("12"); await expect(note).toHaveValue(retainedNote);
    expect(z.array(z.object({ clientOpId: z.uuid() })).parse(await storedFieldData(page, "linenDrafts"))[0]).toEqual(originalDraft);
    await row.getByTestId("field-linen-save").click(); await expect(row.getByTestId("field-linen-queued")).toHaveText(t.queued);
    const original = entries.parse(await storedFieldData(page))[0]; expect(original.operation.client_op_id).toBe(originalDraft.clientOpId);
    await page.reload(); await expect(row.getByTestId("field-linen-queued")).toBeVisible(); expect(entries.parse(await storedFieldData(page))[0]).toEqual(original);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const concurrent = syncPushInputSchema.parse({ organization_id: f.organizationId, actor_user_id: user.id, device_id: randomUUID(), op_schema_version: 1,
      ops: [{ type: "field_stocktake.record", client_op_id: randomUUID(), payload: { ...original.operation.payload, countedQuantity: "11", note: "Concurrent authorized physical count on another device" } }] });
    const remoteResult = await remote.post("/api/sync/push", { data: concurrent, headers: { Origin: origin } }); expect(remoteResult.status()).toBe(200);
    expect(z.object({ results: z.array(z.object({ status: z.string() })) }).parse(await remoteResult.json()).results[0].status).toBe("APPLIED");
    const heldConflictPull = new Promise<void>(resolve => { releaseConflictPull = resolve; }); let conflictPullHeld = false;
    await page.context().route("**/api/sync/pull**", async route => { const response = await route.fetch(); conflictPullHeld = true;
      await heldConflictPull; await route.fulfill({ response }); });
    await network.release(); await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(row.getByTestId("field-linen-review-required")).toBeVisible();
    await expect.poll(async () => entries.parse(await storedFieldData(page)).find(entry => entry.operation.client_op_id === original.operation.client_op_id)?.syncStatus).toBe("conflict");
    await expect(row.getByTestId("field-linen-save")).toBeDisabled(); await expect(row.getByTestId("field-linen-review" )).toBeEnabled();
    await expect(row.getByTestId("field-linen-review-required")).toContainText(new Intl.NumberFormat(locale).format(11));
    await expect.poll(() => conflictPullHeld).toBe(true);
    const cachedConflictPosition = z.array(z.object({ task: z.object({ id: z.uuid(), linen: z.object({ items: z.array(z.object({ quantity: z.string(), revision: z.string() })) }) }) }))
      .parse(await storedFieldData(page, "jobs")).find(job => job.task.id === f.taskId)!.task.linen.items[0];
    expect(cachedConflictPosition).toMatchObject({ quantity: "11", revision: "1" });
    await row.getByTestId("field-linen-review").click(); await expect(count).toHaveValue(""); await expect(note).toHaveValue(retainedNote);
    const reviewed = z.array(z.object({ clientOpId: z.uuid(), expectedQuantity: z.string(), expectedRevision: z.string() })).parse(await storedFieldData(page, "linenDrafts"))[0];
    expect(reviewed.clientOpId).not.toBe(original.operation.client_op_id); expect(reviewed).toMatchObject({ expectedQuantity: "11", expectedRevision: "1" });
    releaseConflictPull?.(); await page.context().unrouteAll({ behavior: "wait" });
    await count.fill("12"); await row.getByTestId("field-linen-save").click();
    await expect.poll(async () => entries.parse(await storedFieldData(page)).filter(entry => !entry.resolvedByClientOpId)).toEqual([]);
    const history = entries.parse(await storedFieldData(page)); expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ operation: original.operation, syncStatus: "conflict", resolvedByClientOpId: reviewed.clientOpId });
    await expect(count).toHaveValue("12"); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Invalid intermediate typing remains a draft, even when another device
    // changes stock and turns that draft into an explicit review.
    await count.fill("1.5"); await note.fill("Retain an invalid intermediate entry through a stock refresh");
    await expect(row.getByRole("alert")).toHaveText(t.invalid); await expect(row.getByTestId("field-linen-save")).toBeDisabled();
    await expect.poll(async () => z.array(z.object({ countedQuantity: z.string() })).parse(await storedFieldData(page, "linenDrafts"))[0]?.countedQuantity).toBe("1.5");
    const nextRemote = syncPushInputSchema.parse({ ...concurrent, ops: [{ ...concurrent.ops[0], client_op_id: randomUUID(), payload: {
      ...concurrent.ops[0].payload, expectedQuantity: "12", expectedRevision: "2", countedQuantity: "13", note: "Another authorized physical count during draft editing" } }] });
    const nextResult = await remote.post("/api/sync/push", { data: nextRemote, headers: { Origin: origin } }); expect(nextResult.status()).toBe(200);
    expect(z.object({ results: z.array(z.object({ status: z.string() })) }).parse(await nextResult.json()).results[0].status).toBe("APPLIED");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(row.getByTestId("field-linen-review-required")).toBeVisible(); await expect(count).toHaveValue("1.5");
    await expect(row.getByTestId("field-linen-review-required")).toContainText("1.5");
    await row.getByTestId("field-linen-review").click(); await expect(count).toHaveValue(""); await count.fill("13");
    await row.getByTestId("field-linen-save").click();
    await expect.poll(async () => entries.parse(await storedFieldData(page)).filter(entry => !entry.resolvedByClientOpId)).toEqual([]);
    await expect(count).toHaveValue("13"); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`linen-${locale}.png`), fullPage: true });
    await withTenant(f.db, f.organizationId, async tx => {
      const observations = await tx.inventoryStocktake.findMany({ where: { taskId: f.taskId }, orderBy: { revision: "asc" } });
      expect(observations.map(observation => observation.countedQuantity)).toEqual([11n, 12n, 13n, 13n]);
      expect(observations[1]).toMatchObject({ clientOpId: reviewed.clientOpId, configRuleId: rule.id, note: retainedNote });
      expect(await tx.syncOp.count({ where: { deviceId: original.deviceId } })).toBe(3);
      expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record", resourceId: { in: observations.map(observation => observation.id) } } })).toBe(4);
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ state: "ASSIGNED", completedAt: null });
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(0);
    });
  } finally { releaseConflictPull?.(); await page.context().unrouteAll({ behavior: "wait" }); await network.close(); await remote.dispose(); await f.db.$disconnect(); }
});
