import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Request as PlaywrightRequest } from "@playwright/test";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };
import { withTenant } from "@/platform/db/tenant";
import { storedFieldData } from "./support/field-storage";
import { openFieldFixture } from "./support/field-fixture";
import { fieldBrowser } from "./support/field-browser";

test.use({ actionTimeout: 30000, navigationTimeout: 30000, serviceWorkers: "allow", channel: "chromium" });
for (const locale of ["en", "fr", "ar"] as const) test(`Field PWA installability and safe update with queued work in ${locale}`, async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required for Field PWA acceptance"); test.setTimeout(180000);
  expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page, t = { en, fr, ar }[locale];
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined;
  try {
    await page.addInitScript(() => {
      const messages: Array<{ at: number; script: string; state: string; type: unknown }> = [];
      Object.defineProperty(window, "fieldWorkerMessages", { value: messages });
      const send: unknown = Object.getOwnPropertyDescriptor(ServiceWorker.prototype, "postMessage")?.value;
      if (typeof send !== "function") throw new Error("Native worker messaging unavailable");
      ServiceWorker.prototype.postMessage = function (this: ServiceWorker, ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) {
        const data = args[0];
        messages.push({ at: Date.now(), script: new URL(this.scriptURL).pathname + new URL(this.scriptURL).search,
          state: this.state, type: data && typeof data === "object" && "type" in data ? data.type : null });
        Reflect.apply(send, this, args);
      };
    });
    const f = await openFieldFixture(page, info, locale); fixture = f;
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const manifest = await page.request.get(`/${locale}/manifest.webmanifest`);
    expect(await manifest.json()).toMatchObject({ lang: locale, dir: locale === "ar" ? "rtl" : "ltr", start_url: `/${locale}/app/field`, display: "standalone" });
    const cdp = await page.context().newCDPSession(page);
    const nativeManifest = await cdp.send("Page.getAppManifest"); expect(nativeManifest.errors).toEqual([]);
    expect(nativeManifest.url).toContain(`/${locale}/manifest.webmanifest`);
    await expect.poll(async () => (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
    await cdp.detach();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const check = page.getByTestId("field-checklist-item"); await check.focus(); await page.keyboard.press("Space");
    const note = page.getByTestId("field-task-complete-form").locator('textarea[name="note"]'); await note.fill("Queued work survives a service worker update");
    await page.evaluate(() => navigator.serviceWorker.addEventListener("controllerchange", event => event.stopImmediatePropagation(), { capture: true }));
    await page.evaluate(async suffix => {
      await navigator.serviceWorker.register(`/sw.js?acceptance=${suffix}`, { scope: "/", updateViaCache: "none" });
    }, randomUUID());
    const update = page.getByTestId("field-update"); await expect(update).toBeVisible(); await update.click();
    await expect(page.getByTestId("field-pwa-notice")).toHaveText(t.FieldPwa.saveBeforeUpdate); await expect(check).toBeChecked();
    await page.context().setOffline(true); await page.getByTestId("field-task-complete").click();
    await expect(page.getByTestId("field-task-sync-status")).toHaveText(t.Field.offlineQueued); await expect(update).toBeDisabled();
    const queued = await storedFieldData(page); expect(queued).toHaveLength(1);
    await page.context().route("**/api/sync/push", route => route.abort()); await page.context().setOffline(false);
    await expect(update).toBeEnabled();
    const pendingRequests = new Set<string>();
    const nativeEvents: unknown[] = [], lifecycle = await page.context().newCDPSession(page);
    lifecycle.on("ServiceWorker.workerVersionUpdated", event => {
      nativeEvents.push({ at: Date.now(), versions: event.versions.map(worker => ({ id: worker.versionId, status: worker.status,
        running: worker.runningStatus, script: new URL(worker.scriptURL).pathname + new URL(worker.scriptURL).search })) });
    });
    lifecycle.on("Page.frameStartedLoading", () => nativeEvents.push({ at: Date.now(), type: "frameStartedLoading" }));
    lifecycle.on("Page.lifecycleEvent", event => nativeEvents.push({ at: Date.now(), type: event.name }));
    lifecycle.on("Inspector.targetCrashed", () => nativeEvents.push({ at: Date.now(), type: "targetCrashed" }));
    await lifecycle.send("Page.enable"); await lifecycle.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await lifecycle.send("ServiceWorker.enable");
    const requestStarted = (request: PlaywrightRequest) => pendingRequests.add(new URL(request.url()).pathname);
    const requestFinished = (request: PlaywrightRequest) => pendingRequests.delete(new URL(request.url()).pathname);
    page.on("request", requestStarted); page.on("requestfinished", requestFinished); page.on("requestfailed", requestFinished);
    const previousDocument = await page.evaluate(() => performance.timeOrigin);
    try {
      const refreshed = page.waitForEvent("load"); await update.click(); await refreshed;
    } catch (error) {
      const diagnostic = page.evaluate(async () => {
        const worker = await navigator.serviceWorker.getRegistration();
        return { documentReadyState: document.readyState, timeOrigin: performance.timeOrigin,
          dirty: Boolean(document.querySelector('[data-field-dirty="true"]')), visibility: document.visibilityState,
          updateDisabled: document.querySelector<HTMLButtonElement>('[data-testid="field-update"]')?.disabled,
          notice: document.querySelector('[data-testid="field-pwa-notice"]')?.textContent,
          controller: navigator.serviceWorker.controller?.state, waiting: worker?.waiting?.state, installing: worker?.installing?.state,
          sentMessages: "fieldWorkerMessages" in window ? window.fieldWorkerMessages : [] };
      }).catch(() => ({ documentUnavailable: true }));
      let diagnosticTimeout: ReturnType<typeof setTimeout> | undefined;
      const state = await Promise.race([diagnostic, new Promise<{ documentUnavailable: true }>(resolve => {
        diagnosticTimeout = setTimeout(() => resolve({ documentUnavailable: true }), 3000);
      })]);
      if (diagnosticTimeout) clearTimeout(diagnosticTimeout);
      console.log(JSON.stringify({ fieldPwaRefreshFailure: { locale, project: info.project.name, previousDocument, state, pendingPaths: [...pendingRequests], nativeEvents } }));
      throw error;
    } finally { page.off("request", requestStarted); page.off("requestfinished", requestFinished); page.off("requestfailed", requestFinished); await lifecycle.detach(); }
    await expect(note).toHaveValue("Queued work survives a service worker update"); await expect(check).toBeChecked();
    expect(await storedFieldData(page)).toEqual(queued);
    await expect(page.getByTestId("field-task-sync-status")).toHaveText(t.Field.offlineQueued);
    const jobsUrl = new RegExp(`/${locale}/app/field$`, "u");
    const returnedToJobs = page.waitForURL(jobsUrl, { waitUntil: "domcontentloaded" });
    await page.context().unroute("**/api/sync/push"); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await returnedToJobs;
    await expect(page).toHaveURL(jobsUrl); await expect(page.getByTestId("field-page")).toBeVisible(); expect(await storedFieldData(page)).toEqual([]);
    expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { action: "task.complete", resourceId: f.taskId } }))).toBe(1);
    const asset = await page.locator('script[src*="/_next/static/"]').first().getAttribute("src"); expect(asset).toBeTruthy();
    await page.evaluate(async asset => { await (await fetch(asset, { cache: "reload" })).text(); }, asset!);
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      return urls;
    });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.every(path => path.startsWith("/_next/static/") || /^\/(en|fr|ar)\/offline\/field$/u.test(path))).toBe(true);
    for (const language of ["en", "fr", "ar"]) expect(cached).toContain(`/${language}/offline/field`);
  } finally { await fixture?.db.$disconnect(); await native.close(); }
});

test("Field background sync completes once after the task page closes", async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required for background sync acceptance"); test.setTimeout(180000);
  expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page;
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined;
  try {
    const f = await openFieldFixture(page, info, "en"); fixture = f;
    const cdp = await page.context().newCDPSession(page); let registrationId: string | undefined;
    cdp.on("ServiceWorker.workerRegistrationUpdated", event => {
      registrationId = event.registrations.find(registration => registration.scopeURL === "http://127.0.0.1:3000/")?.registrationId ?? registrationId;
    });
    await cdp.send("ServiceWorker.enable"); await expect.poll(() => registrationId).toBeTruthy();
    await page.getByTestId("field-checklist-item").check(); await page.context().setOffline(true);
    await page.getByTestId("field-task-complete").click(); await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
    await expect.poll(() => page.evaluate(async () => {
      const registration: ServiceWorkerRegistration & { sync?: { getTags(): Promise<string[]> } } = await navigator.serviceWorker.ready;
      return await registration.sync?.getTags() ?? [];
    })).toContain("alvillas-field-queue");
    await page.goto("about:blank"); await page.context().setOffline(false);
    await cdp.send("ServiceWorker.dispatchSyncEvent", { origin: "http://127.0.0.1:3000", registrationId: registrationId!, tag: "alvillas-field-queue", lastChance: false });
    await cdp.send("ServiceWorker.dispatchSyncEvent", { origin: "http://127.0.0.1:3000", registrationId: registrationId!, tag: "alvillas-field-queue", lastChance: false });
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { action: "task.complete", resourceId: f.taskId } })), { timeout: 30000 }).toBe(1);
    expect(await withTenant(f.db, f.organizationId, tx => tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } }))).toBe(1);
    await cdp.detach();
  } finally {
    await fixture?.db.$disconnect(); await native.close();
  }
});
