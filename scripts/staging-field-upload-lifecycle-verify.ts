import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { chromium, expect as playwrightExpect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { fieldUploadManifestSchema } from "../src/modules/reservations/domain/field-upload";
import { fieldUploadLifecycleKey } from "../src/platform/config/field-upload-lifecycle-policy";
import { syncPushInputSchema } from "../src/modules/reservations/domain/sync-protocol";
import { storedFieldData } from "../tests/e2e/support/field-storage";
import { blockStagingWorkerSync } from "./support/staging-worker-network";

const expect = playwrightExpect.configure({ timeout: 30000 }), origin = "https://the-alvillas-os-staging.vercel.app";
const evidenceSchema = z.object({ accountKind: z.literal("dedicated-field-open-lifecycle"), completed: z.literal(false),
  expectedSha: z.string().regex(/^[a-f0-9]{40}$/u), captureSha: z.string().regex(/^[a-f0-9]{40}$/u), nativePartialTransfer: z.literal(true),
  organizationId: z.uuid(), actorId: z.uuid(), actorPersonId: z.uuid(), administratorId: z.uuid(), propertyId: z.uuid(),
  originalNonce: z.uuid(), originalDevice: z.uuid(), uploadId: z.uuid(),
  tasks: z.array(z.object({ id: z.uuid(), assigned: z.literal(true) })).length(1),
  originalQueue: z.array(z.object({ organizationId: z.uuid(), userId: z.uuid(), deviceId: z.uuid(),
    operation: z.object({ client_op_id: z.uuid(), type: z.literal("field_task.evidence.attach"), payload: z.object({ taskId: z.uuid(), uploadId: z.uuid() }) }) })).length(1),
  originalPhoto: z.object({ manifest: fieldUploadManifestSchema, uploadedParts: z.array(z.literal(0)).length(1), ready: z.literal(false) }) });

/** Continue the live original browser; never reopen or recreate its queued capture. */
export async function verifyStagingFieldUploadLifecycle(input: { context: BrowserContext; page: Page; evidence: Record<string, unknown>;
  gate: Awaited<ReturnType<typeof blockStagingWorkerSync>>; file: string; profile: string; administratorState: string }) {
  const f = evidenceSchema.parse(input.evidence), taskId = f.tasks[0].id, original = f.originalQueue[0];
  if (f.captureSha === f.expectedSha || f.originalPhoto.manifest.taskId !== taskId || f.originalPhoto.manifest.localId !== f.originalNonce ||
    original.operation.client_op_id !== f.originalNonce || original.operation.payload.uploadId !== f.uploadId || original.operation.payload.taskId !== taskId ||
    original.organizationId !== f.organizationId || original.userId !== f.actorId || original.deviceId !== f.originalDevice) throw Error("Original native capture identity required");
  const parent = await realpath(dirname(input.administratorState));
  if (dirname(await realpath(input.profile)) !== parent || dirname(await realpath(input.file)) !== parent || basename(input.profile) !== "staging-field-open-lifecycle-native")
    throw Error("Original private native capture profile required");
  const { context, page, evidence } = input, ownerBrowser = await chromium.launch(), owner = await ownerBrowser.newContext({ baseURL: origin, storageState: input.administratorState });
  owner.setDefaultTimeout(30000); owner.setDefaultNavigationTimeout(90000); const editor = await owner.newPage();
  const checks: Array<{ locale: string; width: number }> = [], wire: Array<{ nonce: string; device: string; status: string }> = [], errors: string[] = [];
  evidence.checks = checks; evidence.wire = wire; let phase = "current-preview-authentication", gate = input.gate, allowPush = false, holdAcknowledgements = true, appliedLost = false;
  const checkpoint = () => writeFile(input.file, JSON.stringify({ ...evidence, phase, workerTransport: gate.state() }, null, 2));
  page.on("pageerror", error => errors.push(error.message));
  const photoState = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("alvillas.field.v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Native database unavailable")); });
    try {
      const rows = await new Promise<Array<{ blob: Blob; manifest: unknown; uploadId: string; generation?: number; uploadedParts: number[]; ready: boolean }>>((resolve, reject) => {
        const request = db.transaction("photos").objectStore("photos").getAll(); request.onsuccess = () => resolve(request.result as Array<{ blob: Blob; manifest: unknown; uploadId: string; generation?: number; uploadedParts: number[]; ready: boolean }>); request.onerror = () => reject(new Error("Native photo unavailable"));
      });
      if (rows.length !== 1) throw new Error("Original native photo required"); const row = rows[0];
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await row.blob.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");
      return { size: row.blob.size, digest, manifest: row.manifest, uploadId: row.uploadId, generation: row.generation ?? 1, uploadedParts: row.uploadedParts, ready: row.ready };
    } finally { db.close(); }
  });
  try {
    expect(await (await owner.request.get("/api/version")).json()).toMatchObject({ version: f.expectedSha, environment: "preview", commitRef: "main" });
    for (const [current, actor] of [[context, f.actorId], [owner, f.administratorId]] as const) {
      const session = z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), securitySetupRequired: z.boolean(), sessionRevoked: z.boolean().optional() }) })
        .parse(await (await current.request.get("/api/auth/session")).json());
      expect(session.user).toMatchObject({ id: actor, organizationId: f.organizationId, securitySetupRequired: false }); expect(session.user.sessionRevoked).not.toBe(true);
    }
    expect(await photoState()).toMatchObject({ digest: f.originalPhoto.manifest.sha256, size: f.originalPhoto.manifest.size, generation: 1, uploadedParts: [0], ready: false });
    expect(await storedFieldData(page)).toEqual(evidence.originalQueue);
    phase = "native-deployment-upgrade"; await context.setOffline(false);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); }); await expect(page.getByTestId("field-update")).toBeVisible();
    const worker = await context.request.get("/sw.js"); expect(worker.status()).toBe(200); expect((await worker.text()).startsWith(`self.ALVILLAS_RELEASE = "${f.expectedSha}";`)).toBe(true);
    await page.evaluate(async () => { const waiting = (await navigator.serviceWorker.getRegistration())?.waiting; if (!waiting) throw Error("Actual deployment worker required");
      window.addEventListener("beforeunload", () => sessionStorage.setItem("field-native-upload-upgrade", String(navigator.serviceWorker.controller === waiting)), { once: true }); });
    const loaded = page.waitForEvent("load"); await page.getByTestId("field-update").click(); await loaded;
    expect(await page.evaluate(() => sessionStorage.getItem("field-native-upload-upgrade"))).toBe("true");
    expect(await photoState()).toMatchObject({ digest: f.originalPhoto.manifest.sha256, generation: 1, uploadedParts: [0], ready: false });
    expect(await storedFieldData(page)).toEqual(evidence.originalQueue); evidence.originalCaptureRetainedAcrossUpgrade = true; await checkpoint();
    const configure = async (minutes: number | null) => {
    phase = minutes === null ? "disable-dedicated-lifecycle-policy" : "native-explicit-lifecycle-policy"; await editor.goto("/en/app/configuration"); const form = editor.getByTestId("config-rule-create-form");
    await form.locator('[name="scopeType"][value="property"]').check(); await form.getByTestId("config-rule-scope-id").selectOption(f.propertyId);
    await form.getByTestId("config-rule-key").selectOption(fieldUploadLifecycleKey); await form.getByTestId("config-rule-lifecycle").selectOption("ACTIVE");
    await form.getByTestId("config-rule-value").fill(JSON.stringify({ openUploadIdleAfterMinutes: minutes })); await form.getByTestId("config-rule-effective-from").fill("2020-01-01T00:00");
    await form.getByTestId("config-rule-reason").fill("Dedicated native transport expiry and original photo recovery acceptance");
    expect(await form.evaluate(element => Object.fromEntries(new FormData(element as HTMLFormElement).entries()))).toMatchObject({ key: fieldUploadLifecycleKey, scopeType: "property", scopeId: f.propertyId, lifecycle: "ACTIVE", valueJson: JSON.stringify({ openUploadIdleAfterMinutes: minutes }) });
    evidence[minutes === null ? "lifecycleDisableSubmitted" : "lifecyclePolicySubmitted"] = true; await checkpoint(); await form.getByTestId("config-rule-submit").click(); await expect(form.getByTestId("config-rule-form-message")).toHaveAttribute("role", "status");
    evidence[minutes === null ? "lifecycleDisabled" : "lifecycleEnabled"] = true; await checkpoint();
    };
    await configure(0);
    await writeFile(".tmp/field-open-lifecycle-policy-configured-ready.json", JSON.stringify({ completed: true, sha: f.expectedSha, organizationId: f.organizationId, actorId: f.actorId,
      administratorId: f.administratorId, propertyId: f.propertyId, uploadId: f.uploadId, originalNonce: f.originalNonce }, null, 2));
    phase = "offline-original-capture-layouts"; await context.setOffline(true); await page.reload();
    for (const locale of ["en", "fr", "ar"] as const) for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      if (await page.locator("html").getAttribute("lang") !== locale) await page.getByTestId("field-language").getByTestId(`locale-switch-${locale}`).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale); await page.reload(); await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.getByTestId("field-photo-queued")).toBeVisible(); expect(await photoState()).toMatchObject({ digest: f.originalPhoto.manifest.sha256, generation: 1, uploadedParts: [0], ready: false });
      expect(await storedFieldData(page)).toEqual(evidence.originalQueue); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); checks.push({ locale, width }); await checkpoint();
    }
    phase = "real-signed-lease-and-cron-cleanup";
    let expired: { configRuleId: string; configVersion: number } | undefined;
    for (let attempt = 0; ; attempt++) {
      try { expired = z.object({ completed: z.literal(true), sha: z.literal(f.expectedSha), uploadId: z.literal(f.uploadId), originalNonce: z.literal(f.originalNonce),
        originalDevice: z.literal(f.originalDevice), originalLeaseExpired: z.literal(true), oldGenerationCleaned: z.literal(true), configRuleId: z.uuid(), configVersion: z.number().int().positive() })
        .parse(JSON.parse(await readFile(".tmp/field-open-lifecycle-expired-ready.json", "utf8"))); } catch { /* Read-only verification waits for the actual signed cleanup job. */ }
      if (expired) break; if (attempt === 180) throw Error("Actual original signed lease and cleanup proof required"); await new Promise(resolve => setTimeout(resolve, 10000));
    }
    evidence.expiryPolicy = { configRuleId: expired.configRuleId, configVersion: expired.configVersion, openUploadIdleAfterMinutes: 0 }; evidence.realLeaseAndCleanupVerified = true; await checkpoint();
    // Install the new native push fault before detaching the capture-phase gate.
    // This releases upload transport while retaining native push protection.
    const nextGate = await blockStagingWorkerSync(input.profile, origin); expect(nextGate.state().configuredWorkers).toBeGreaterThan(0); gate.close(); gate = nextGate;
    await gate.blockAllUploadTransport(false);
    for (const pattern of ["**/api/field/uploads/part?**", "**/api/field/uploads/complete", "**/api/field/uploads"]) await context.unroute(pattern);
    await context.route("**/api/sync/push", async route => {
      if (!allowPush || (holdAcknowledgements && appliedLost)) { await route.abort(); return; }
      try {
        const batch = syncPushInputSchema.parse(route.request().postDataJSON()); expect(batch.device_id).toBe(f.originalDevice); expect(batch.ops).toHaveLength(1);
        expect(batch.ops[0]).toMatchObject({ client_op_id: f.originalNonce, type: "field_task.evidence.attach", payload: { taskId, uploadId: f.uploadId } });
        const response = await route.fetch(); expect(response.status()).toBe(200);
        const result = z.object({ results: z.array(z.object({ client_op_id: z.uuid(), status: z.string() })).length(1) }).parse(await response.json());
        wire.push(...result.results.map(row => ({ nonce: row.client_op_id, device: batch.device_id, status: row.status })));
        if (holdAcknowledgements) { expect(result.results[0].status).toBe("APPLIED"); appliedLost = true; await route.abort(); } else await route.fulfill({ response });
      } catch { errors.push("native_photo_recovery_transport_unavailable"); await route.abort().catch(() => undefined); }
    });
    phase = "same-key-native-photo-recovery"; await context.setOffline(false); await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await expect.poll(photoState, { timeout: 90000 }).toMatchObject({ generation: 2, uploadId: f.uploadId, digest: f.originalPhoto.manifest.sha256, ready: true,
      uploadedParts: f.originalPhoto.manifest.parts.map((_, index) => index) });
    expect(await storedFieldData(page)).toEqual(evidence.originalQueue); evidence.recoveredPhoto = await photoState(); evidence.originalBlobAndOperationRetained = true; await checkpoint();
    phase = "lost-real-applied-acknowledgement"; allowPush = true; await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await expect.poll(() => appliedLost).toBe(true); evidence.lostAppliedAcknowledgement = true; await checkpoint();
    await context.setOffline(true); await page.reload(); expect(await storedFieldData(page)).toEqual(evidence.originalQueue);
    expect(await photoState()).toMatchObject({ generation: 2, digest: f.originalPhoto.manifest.sha256, ready: true });
    holdAcknowledgements = false; await context.setOffline(false); await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await expect.poll(() => storedFieldData(page)).toEqual([]); await expect.poll(() => storedFieldData(page, "photos")).toEqual([]);
    expect(wire.filter(row => row.status === "APPLIED")).toHaveLength(1); expect(wire.some(row => row.status === "DUPLICATE")).toBe(true); expect(errors).toEqual([]);
    await configure(null);
    evidence.completed = true; evidence.authenticated = true; evidence.sha = f.expectedSha; phase = "complete"; await checkpoint();
    console.log(JSON.stringify({ nativeUploadRecovery: "browser-verified", layouts: checks.length, originalBlobAndKeyRetained: true, realLeaseAndCleanupVerified: true, dataProofPending: true }));
  } catch (error) {
    evidence.nativeFailurePhase = phase; evidence.failure = { phase, name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message.split("\n")[0].replace(/https?:\/\/\S+/gu, "[url]") : "Unavailable" };
    await checkpoint(); console.error(JSON.stringify({ nativeUploadRecovery: "incomplete", phase, originalCheckpointRetained: true })); process.exitCode = 1;
  } finally { await context.close(); gate.close(); await ownerBrowser.close(); }
}
