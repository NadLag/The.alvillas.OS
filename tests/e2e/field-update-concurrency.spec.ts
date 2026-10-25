import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import type { CDPSession, Request } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import en from "../../messages/en.json" with { type: "json" };
import { fieldBrowser } from "./support/field-browser";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";
import { inspectFieldWorker } from "./support/field-worker-diagnostics";
import { fieldNetwork } from "./support/field-network";

test.use({ serviceWorkers: "allow", channel: "chromium" });
test("Explicit update waits for an active foreground cache response without losing queued work", async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for foreground update concurrency"); test.setTimeout(180000);
  expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page;
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined, releasePull: (() => void) | undefined;
  try {
    await page.addInitScript(() => {
      let requested = 0;
      Object.defineProperty(window, "fieldForegroundPromotions", { get: () => requested });
      const send: unknown = Object.getOwnPropertyDescriptor(ServiceWorker.prototype, "postMessage")?.value;
      if (typeof send !== "function") throw Error("Native worker messaging required");
      ServiceWorker.prototype.postMessage = function (this: ServiceWorker, ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) {
        const value = args[0];
        if (value && typeof value === "object" && "type" in value && value.type === "ALVILLAS_SKIP_WAITING") requested++;
        Reflect.apply(send, this, args);
      };
    });
    const f = await openFieldFixture(page, info, "en"); fixture = f;
    const network = await fieldNetwork(native.context, "unavailable"); await network.revision(randomUUID());
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    const update = page.getByTestId("field-update"); await expect(update).toBeVisible();
    await page.getByTestId("field-checklist-item").check();
    await page.getByTestId("field-task-complete-form").locator('textarea[name="note"]').fill("Retain work while a real foreground response is pending");
    await native.context.setOffline(true); await page.getByTestId("field-task-complete").click();
    await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
    const original = await storedFieldData(page); expect(original).toHaveLength(1);
    const key = z.object({ deviceId: z.uuid(), operation: z.object({ client_op_id: z.uuid() }) }).parse(original[0]);
    const held = new Promise<void>(resolve => { releasePull = resolve; }); let pullPending = false;
    await native.context.route("**/api/sync/pull**", async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200); pullPending = true;
      await held; await route.fulfill({ response });
    });
    await native.context.setOffline(false); await expect.poll(() => pullPending).toBe(true); await expect(update).toBeEnabled();
    await expect(page.locator('[data-field-dirty="true"]')).toHaveCount(0);
    const before = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(async () => {
      const expected = (await navigator.serviceWorker.getRegistration())?.waiting;
      window.addEventListener("beforeunload", () => sessionStorage.setItem("field-foreground-controller-adopted", String(Boolean(expected) && navigator.serviceWorker.controller === expected)), { once: true });
    });
    await update.click();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
    expect(await page.evaluate(() => "fieldForegroundPromotions" in window ? window.fieldForegroundPromotions : -1)).toBe(0);
    await expect(page.getByTestId("field-pwa-notice")).toHaveText(en.FieldPwa.unavailable);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(before); expect(await storedFieldData(page)).toEqual(original);
    expect(await page.evaluate(() => "fieldForegroundPromotions" in window ? window.fieldForegroundPromotions : -1)).toBe(0);
    if (!releasePull) throw Error("Native foreground response release required");
    releasePull(); await expect(page.getByTestId("field-sync-now")).toBeEnabled();
    const refreshed = page.waitForEvent("load"); await update.click(); await refreshed;
    expect(await page.evaluate(() => sessionStorage.getItem("field-foreground-controller-adopted"))).toBe("true");
    expect(await storedFieldData(page)).toEqual(original);
    expect(await withTenant(f.db, f.organizationId, tx => tx.syncOp.count({ where: { payload: { path: ["taskId"], equals: f.taskId } } }))).toBe(0);
    await network.release(); const jobs = page.waitForURL(/\/en\/app\/field$/u); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await jobs;
    await expect.poll(() => storedFieldData(page)).toEqual([]);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.syncOp.count({ where: { deviceId: key.deviceId, clientOpId: key.operation.client_op_id, status: "APPLIED" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.complete" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(1);
    });
  } finally { releasePull?.(); await native.close(); await fixture?.db.$disconnect(); }
});
test("Explicit update retains queued work while a native background acknowledgement is still pending", async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for update/background concurrency"); test.setTimeout(180000); expect(browserName).toBe("chromium");
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Update concurrency fixtures require local PostgreSQL");
  const native = await fieldBrowser(info), page = native.page;
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined, network: Awaited<ReturnType<typeof fieldNetwork>> | undefined;
  let phase = "fixture";
  let browserTraceSession: CDPSession | undefined;
  const browserTrace: unknown[] = [];
  let originalVersionId: string | undefined, originalStoppedAt = 0, releasedAt = 0;
  const lifecycle: unknown[] = [], pending = new Set<Request>();
  native.context.on("request", request => { if (new URL(request.url()).origin === "http://127.0.0.1:3000") pending.add(request); });
  const requestFinished = (request: Request) => pending.delete(request);
  native.context.on("requestfinished", requestFinished); native.context.on("requestfailed", requestFinished);
  try {
    const cdp = await native.context.newCDPSession(page); browserTraceSession = cdp; let registrationId: string | undefined;
    cdp.on("Tracing.dataCollected", event => browserTrace.push(...event.value as unknown[]));
    await cdp.send("Tracing.start", { categories: "ServiceWorker", transferMode: "ReportEvents" });
    const f = await openFieldFixture(page, info, "en"); fixture = f;
    expect(native.context.serviceWorkers()).toHaveLength(1);
    const originalWorker = native.context.serviceWorkers()[0];
    await originalWorker.evaluate(() => {
      const scope = globalThis as unknown as ServiceWorkerGlobalScope & { fieldBackgroundDiagnostic: { started: number; pending: number; settled: number } };
      scope.fieldBackgroundDiagnostic = { started: 0, pending: 0, settled: 0 };
      const waitUntil: unknown = Object.getOwnPropertyDescriptor(ExtendableEvent.prototype, "waitUntil")?.value;
      if (typeof waitUntil !== "function") throw new Error("Native background event lifetime unavailable");
      ExtendableEvent.prototype.waitUntil = function (this: ExtendableEvent, promise: Promise<unknown>) {
        if (this.type === "sync" && "tag" in this && this.tag === "alvillas-field-queue") {
          scope.fieldBackgroundDiagnostic.started += 1; scope.fieldBackgroundDiagnostic.pending += 1;
          const settled = () => { scope.fieldBackgroundDiagnostic.pending -= 1; scope.fieldBackgroundDiagnostic.settled += 1; };
          void Promise.resolve(promise).then(settled, settled);
        }
        Reflect.apply(waitUntil, this, [promise]);
      };
    });
    cdp.on("ServiceWorker.workerRegistrationUpdated", event => { registrationId = event.registrations.find(row => row.scopeURL === "http://127.0.0.1:3000/")?.registrationId ?? registrationId; });
    cdp.on("ServiceWorker.workerVersionUpdated", event => {
      originalVersionId ??= event.versions.find(row => row.status === "activated")?.versionId;
      if (event.versions.some(row => row.versionId === originalVersionId && row.runningStatus === "stopped")) originalStoppedAt = Date.now();
      lifecycle.push({ at: Date.now(), versions: event.versions.map(row => ({ id: row.versionId, state: row.status, running: row.runningStatus })) });
    });
    await cdp.send("ServiceWorker.enable"); await expect.poll(() => registrationId).toBeTruthy();
    await page.getByTestId("field-checklist-item").check(); await native.context.setOffline(true); await page.getByTestId("field-task-complete").click();
    await expect(page.getByTestId("field-task-sync-status")).toHaveText(en.Field.offlineQueued);
    const queued = await storedFieldData(page); expect(queued).toHaveLength(1);
    network = await fieldNetwork(native.context, "hold"); let workerRequest = false;
    native.context.on("request", request => { if (new URL(request.url()).pathname === "/api/sync/push" && request.serviceWorker()) workerRequest = true; });
    await page.goto("about:blank");
    await native.context.setOffline(false);
    const dispatched = cdp.send("ServiceWorker.dispatchSyncEvent", { origin: "http://127.0.0.1:3000", registrationId: registrationId!, tag: "alvillas-field-queue", lastChance: false }).then(() => true, () => false);
    await expect.poll(async () => (await network!.state()).heldResponses).toContainEqual({ status: 200, results: ["APPLIED"] });
    expect(workerRequest).toBe(true);
    expect(await originalWorker.evaluate(() => (globalThis as unknown as { fieldBackgroundDiagnostic: { pending: number } }).fieldBackgroundDiagnostic.pending)).toBeGreaterThan(0);
    phase = "background-applied";
    expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { action: "task.complete", resourceId: f.taskId } }))).toBe(1);
    await page.goto("/en/app/field"); expect(await storedFieldData(page)).toEqual(queued);
    const originalWorkers = new Set(native.context.serviceWorkers());
    await network.revision(randomUUID()); await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    const update = page.getByTestId("field-update"); await expect(update).toBeVisible(); const before = await page.evaluate(() => performance.timeOrigin);
    await expect.poll(() => native.context.serviceWorkers().filter(worker => !originalWorkers.has(worker)).length).toBe(1);
    const replacement = native.context.serviceWorkers().find(worker => !originalWorkers.has(worker))!;
    await replacement.evaluate(() => {
      const scope = globalThis as unknown as ServiceWorkerGlobalScope & { fieldHeldDiagnostic: { messages: number; calls: number; resolved: number; rejected: number } };
      scope.fieldHeldDiagnostic = { messages: 0, calls: 0, resolved: 0, rejected: 0 };
      const skip = scope.skipWaiting.bind(scope);
      scope.skipWaiting = () => { scope.fieldHeldDiagnostic.calls += 1; const promise = skip();
        void promise.then(() => { scope.fieldHeldDiagnostic.resolved += 1; }, () => { scope.fieldHeldDiagnostic.rejected += 1; }); return promise; };
      scope.addEventListener("message", event => { const value: unknown = event.data;
        if (value && typeof value === "object" && "type" in value && value.type === "ALVILLAS_SKIP_WAITING") scope.fieldHeldDiagnostic.messages += 1;
      });
    });
    await page.evaluate(async () => {
      const expected = (await navigator.serviceWorker.getRegistration())?.waiting;
      Object.defineProperty(window, "fieldExpectedUpgrade", { value: expected });
      window.addEventListener("beforeunload", () => sessionStorage.setItem("field-update-controller-adopted", String(Boolean(expected) && navigator.serviceWorker.controller === expected)), { once: true });
    });
    await update.click(); await expect(page.getByTestId("field-pwa-notice")).toHaveText(en.FieldPwa.unavailable);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(before); expect(await storedFieldData(page)).toEqual(queued);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
    phase = "acknowledgement-released"; releasedAt = Date.now(); await network.release();
    let dispatchDeadline: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([dispatched, new Promise<false>(resolve => { dispatchDeadline = setTimeout(() => resolve(false), 10000); })]);
    if (dispatchDeadline) clearTimeout(dispatchDeadline);
    expect(completed).toBe(true); phase = "background-settled";
    await expect.poll(() => storedFieldData(page)).toEqual([]);
    // CDP acknowledges dispatch immediately; observe the real waitUntil promise.
    await expect.poll(async () => {
      try {
        return await originalWorker.evaluate(() => {
          const value = (globalThis as unknown as { fieldBackgroundDiagnostic: { started: number; pending: number; settled: number } }).fieldBackgroundDiagnostic;
          return value.started > 0 && value.pending === 0 && value.settled === value.started;
        });
      } catch {
        // Native idle termination can discard this runtime after its work
        // finishes, before a later request restarts the same active version.
        return releasedAt > 0 && originalStoppedAt >= releasedAt;
      }
    }).toBe(true);
    phase = "explicit-retry"; const refreshed = page.waitForEvent("load"); await update.click(); await refreshed;
    expect(await page.evaluate(() => sessionStorage.getItem("field-update-controller-adopted"))).toBe("true");
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(before); expect(await storedFieldData(page)).toEqual([]);
    expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { action: "task.complete", resourceId: f.taskId } }))).toBe(1);
    expect(await withTenant(f.db, f.organizationId, tx => tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } }))).toBe(1);
    await cdp.send("Tracing.end"); await cdp.detach(); browserTraceSession = undefined;
  } catch (error) {
    let stateDeadline: ReturnType<typeof setTimeout> | undefined;
    const capture = page.evaluate(async () => {
      const worker = await navigator.serviceWorker.getRegistration();
      return { waiting: worker?.waiting?.state, active: worker?.active?.state, controller: navigator.serviceWorker.controller?.state,
        notice: document.querySelector('[data-testid="field-pwa-notice"]')?.textContent, timeOrigin: performance.timeOrigin,
        adopted: sessionStorage.getItem("field-update-controller-adopted") };
    }).catch(() => ({ unavailable: true }));
    const state = await Promise.race([capture, new Promise<{ unavailable: true }>(resolve => { stateDeadline = setTimeout(() => resolve({ unavailable: true }), 3000); })]);
    if (stateDeadline) clearTimeout(stateDeadline);
    console.log(JSON.stringify({ fieldHeldUpdateFailure: { phase, state, pending: [...pending].map(request => ({ path: new URL(request.url()).pathname, worker: Boolean(request.serviceWorker()) })), lifecycle,
      protocolProbe: await inspectFieldWorker(page) } }));
    let lateAdoption = false;
    try {
      await expect.poll(() => page.evaluate(() => "fieldExpectedUpgrade" in window && window.fieldExpectedUpgrade instanceof ServiceWorker &&
        navigator.serviceWorker.controller === window.fieldExpectedUpgrade && window.fieldExpectedUpgrade.state === "activated"), { timeout: 10000 }).toBe(true);
      lateAdoption = true;
    } catch { /* This observes the already failed case; it never changes its result. */ }
    console.log(JSON.stringify({ fieldHeldLateObservation: { adopted: lateAdoption, afterReleaseMs: Date.now() - releasedAt, lifecycle } }));
    if (browserTraceSession) {
      let traceDeadline: ReturnType<typeof setTimeout> | undefined;
      const complete = new Promise<boolean>(resolve => browserTraceSession!.once("Tracing.tracingComplete", () => resolve(true)));
      await browserTraceSession.send("Tracing.end");
      const finished = await Promise.race([complete, new Promise<boolean>(resolve => { traceDeadline = setTimeout(() => resolve(false), 3000); })]);
      if (traceDeadline) clearTimeout(traceDeadline);
      await writeFile(info.outputPath("native-worker-browser-timeline.json"), JSON.stringify({ complete: finished, traceEvents: browserTrace }));
      await browserTraceSession.detach(); browserTraceSession = undefined;
    }
    throw error;
  } finally { await network?.close(); await fixture?.db.$disconnect(); await native.close(); }
});
