import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createTranslator } from "next-intl";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";
import en from "../../messages/en.json" with { type: "json" };

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
const drafts = z.array(z.object({ taskId: z.uuid(), checklistItemIds: z.array(z.uuid()), note: z.string() }));
test("Field day cache survives offline reload, language changes and a single durable completion", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for field day cache"); test.setTimeout(240000);
  const f = await openFieldFixture(page, info, "en", { checklistItems: 3 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await expect.poll(() => storedFieldData(page, "jobs")).toHaveLength(1);
    const privateProperty = z.array(z.object({ task: z.object({ propertyName: z.string() }) })).parse(await storedFieldData(page, "jobs"))[0].task.propertyName;
    const publicCache = await page.evaluate(async () => {
      const paths: string[] = [], html: string[] = [];
      for (const key of await caches.keys()) {
        const store = await caches.open(key);
        for (const request of await store.keys()) {
          const path = new URL(request.url).pathname; paths.push(path);
          if (/^\/(en|fr|ar)\/offline\/field$/u.test(path)) html.push(await (await store.match(request))!.text());
        }
      }
      return { paths, html };
    });
    expect(publicCache.paths.every(path => path.startsWith("/_next/static/") || /^\/(en|fr|ar)\/offline\/field$/u.test(path))).toBe(true);
    expect(publicCache.html).toHaveLength(3); for (const html of publicCache.html) { expect(html).toContain('data-field-offline-shell="public"'); expect(html).not.toContain(privateProperty); expect(html).not.toContain(f.taskId); }
    await expect(page.getByTestId("field-cache-status")).toHaveText(createTranslator({ locale: "en", messages: en })("FieldCache.ready", { count: 1 }));
    await page.goto("/en/app/field"); await expect(page.getByTestId("field-view-today")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("field-tasks-empty")).toBeVisible(); await page.getByTestId("field-view-assigned").focus(); await page.keyboard.press("Enter");
    await page.getByTestId("field-task-card").click();
    const checks = page.getByTestId("field-checklist-item"), form = page.getByTestId("field-task-complete-form"), note = form.getByRole("textbox");
    await checks.nth(0).check(); await note.fill("Partial offline checklist retained across reload and languages");
    await expect(page.getByTestId("field-draft-saved")).toBeVisible();
    await expect.poll(async () => drafts.parse(await storedFieldData(page, "drafts"))[0]?.note).toBe("Partial offline checklist retained across reload and languages");
    await page.evaluate(() => {
      const target = window as Window & { fieldCacheOriginalPut?: typeof IDBObjectStore.prototype.put };
      target.fieldCacheOriginalPut = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as typeof IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "jobs") throw new DOMException("Storage full", "QuotaExceededError");
        return Reflect.apply(target.fieldCacheOriginalPut!, this, args);
      };
    });
    await withTenant(f.db, f.organizationId, tx => tx.operationTask.update({ where: { id: f.taskId }, data: { priority: "HIGH" } }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("field-cache-status")).toHaveText(en.FieldCache.retry);
    expect(z.array(z.object({ task: z.object({ priority: z.string() }) })).parse(await storedFieldData(page, "jobs"))[0].task.priority).toBe("NORMAL");
    await expect(note).toHaveValue("Partial offline checklist retained across reload and languages");
    await page.evaluate(() => { const target = window as Window & { fieldCacheOriginalPut?: typeof IDBObjectStore.prototype.put }; IDBObjectStore.prototype.put = target.fieldCacheOriginalPut!; delete target.fieldCacheOriginalPut; });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("field-cache-status")).toHaveText(createTranslator({ locale: "en", messages: en })("FieldCache.ready", { count: 1 }));
    await expect(page.getByTestId("field-sync-now")).toBeEnabled();
    const explicitPull = page.waitForResponse(response => new URL(response.url()).pathname === "/api/sync/pull" && response.ok());
    await page.getByTestId("field-sync-now").click();
    await explicitPull;
    await expect.poll(async () => z.array(z.object({ task: z.object({ priority: z.string() }) })).parse(await storedFieldData(page, "jobs"))[0]?.task.priority).toBe("HIGH");
    await page.context().setOffline(true); await page.reload();
    await expect(page).toHaveURL(new RegExp(`/en/offline/field\\?task=${f.taskId}$`, "u"));
    await expect(checks.nth(0)).toBeChecked(); await expect(note).toHaveValue("Partial offline checklist retained across reload and languages");
    await expect(page.getByTestId("field-task-complete")).toBeDisabled();
    for (const locale of ["ar", "fr", "en"] as const) {
      await page.getByTestId("field-language").getByTestId(`locale-switch-${locale}`).focus(); await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${locale}/offline/field\\?task=${f.taskId}$`, "u"));
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(note).toHaveValue("Partial offline checklist retained across reload and languages"); await expect(checks.nth(0)).toBeChecked();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.reload(); await expect(note).toHaveValue("Partial offline checklist retained across reload and languages");
      await expect(checks.nth(0)).toBeChecked(); await page.screenshot({ path: info.outputPath(`offline-cache-${locale}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: en.Field.backToJobs, exact: true }).click();
    await page.getByTestId("field-view-assigned").click(); await page.getByTestId("field-task-card").click();
    await expect(checks.nth(0)).toBeChecked(); await expect(note).toHaveValue("Partial offline checklist retained across reload and languages");
    for (const check of await checks.all()) if (!await check.isChecked()) { await check.focus(); await page.keyboard.press("Space"); }
    await page.getByTestId("field-task-complete").click(); await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
    const queued = await storedFieldData(page); expect(queued).toHaveLength(1);
    await page.reload(); await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued); expect(await storedFieldData(page)).toEqual(queued);
    await expect(page.getByTestId("field-task-complete")).toBeDisabled();
    let appliedResponseLost = false;
    await page.context().route("**/api/sync/push", async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      expect(z.object({ results: z.array(z.object({ status: z.string() })) }).parse(await response.json()).results[0].status).toBe("APPLIED");
      appliedResponseLost = true; await route.abort();
    });
    await page.context().setOffline(false); await expect.poll(() => appliedResponseLost).toBe(true);
    expect(await storedFieldData(page)).toEqual(queued);
    await page.context().setOffline(true); await page.reload(); expect(await storedFieldData(page)).toEqual(queued);
    await page.context().unroute("**/api/sync/push"); await page.context().setOffline(false);
    await expect(page).toHaveURL(/\/en\/app\/field$/u); await expect.poll(() => storedFieldData(page)).toEqual([]);
    await expect.poll(() => storedFieldData(page, "jobs")).toEqual([]); expect(await storedFieldData(page, "drafts")).toEqual([]);
    const proof = await withTenant(f.db, f.organizationId, async tx => ({ audit: await tx.auditLog.count({ where: { action: "task.complete", resourceId: f.taskId } }),
      outbox: await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } }),
      sync: await tx.syncOp.count({ where: { payload: { path: ["taskId"], equals: f.taskId } } }) }));
    expect(proof).toEqual({ audit: 1, outbox: 1, sync: 1 }); expect(errors).toEqual([]);
  } finally { await page.context().setOffline(false); await f.db.$disconnect(); }
});

test("Field cached work is removed after actual session revocation", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for field cache hygiene"); test.setTimeout(180000);
  const f = await openFieldFixture(page, info, "fr");
  try {
    await expect.poll(() => storedFieldData(page, "jobs")).toHaveLength(1);
    const session = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json());
    await page.getByTestId("field-task-complete-form").getByRole("textbox").fill("Private field draft"); await expect(page.getByTestId("field-draft-saved")).toBeVisible();
    await page.goto("/fr/offline/field"); await page.getByTestId("field-view-assigned").click(); await expect(page.getByTestId("field-task-card")).toHaveCount(1);
    await withTenant(f.db, f.organizationId, tx => tx.authSession.updateMany({ where: { userAccountId: session.user.id, revokedAt: null }, data: { revokedAt: new Date() } }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("field-cache-sign-in")).toBeVisible();
    for (const table of ["jobs", "drafts", "operations", "cacheState", "metadata"]) await expect.poll(() => storedFieldData(page, table)).toEqual([]);
    await page.context().setOffline(true); await page.reload(); await expect(page.getByTestId("field-cache-sign-in")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally { await page.context().setOffline(false); await f.db.$disconnect(); }
});

test("Field logout removes saved work, drafts and device metadata before offline reopening", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for field logout"); test.setTimeout(180000);
  const f = await openFieldFixture(page, info, "en");
  try {
    await expect.poll(() => storedFieldData(page, "jobs")).toHaveLength(1);
    await page.getByTestId("field-task-complete-form").getByRole("textbox").fill("Private draft removed by logout"); await expect(page.getByTestId("field-draft-saved")).toBeVisible();
    await page.goto("/en/app"); await page.getByTestId("logout-button").click(); await expect(page).toHaveURL(/\/en\/login$/u);
    for (const table of ["jobs", "drafts", "operations", "cacheState", "metadata"]) expect(await storedFieldData(page, table)).toEqual([]);
    await page.context().setOffline(true); await page.goto("/en/offline/field"); await expect(page.getByTestId("field-cache-sign-in")).toBeVisible();
    await expect(page.getByTestId("field-task-card")).toHaveCount(0);
  } finally { await page.context().setOffline(false); await f.db.$disconnect(); }
});

test("Field My jobs paginates every cached assignment without duplicate cards", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for assigned-job pagination"); test.setTimeout(180000);
  const f = await openFieldFixture(page, info, "en");
  try {
    await expect.poll(() => storedFieldData(page, "jobs")).toHaveLength(1);
    await withTenant(f.db, f.organizationId, async tx => {
      const original = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      await tx.operationTask.createMany({ data: Array.from({ length: 50 }, (_, index) => ({ organizationId: f.organizationId, propertyId: original.propertyId,
        assignedToUserAccountId: original.assignedToUserAccountId, assignedToPersonId: original.assignedToPersonId,
        type: original.type, state: original.state, dueDate: original.dueDate, titleTranslations: { en: `Assigned job ${index + 1}`, fr: `Tâche affectée ${index + 1}`, ar: `المهمة المسندة ${index + 1}` }, idempotencyKey: randomUUID() })) });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => storedFieldData(page, "jobs")).toHaveLength(51);
    await page.goto("/en/app/field"); await page.getByTestId("field-view-assigned").click();
    await expect(page.getByTestId("field-task-card")).toHaveCount(50); await page.getByTestId("field-load-more").focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("field-task-card")).toHaveCount(51);
    const urls = await page.getByTestId("field-task-card").evaluateAll(cards => cards.map(card => card.getAttribute("href")));
    expect(new Set(urls).size).toBe(51); await expect(page.getByTestId("field-load-more")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await f.db.$disconnect(); }
});
