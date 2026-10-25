import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { fieldUploadLifecycleKey } from "@/platform/config/field-upload-lifecycle-policy";
import { fieldUploadManifestSchema } from "@/modules/reservations/domain/field-upload";
import { operationHash } from "@/modules/reservations/application/operation-hash";
import { fieldBrowser } from "./support/field-browser";
import { openFieldFixture } from "./support/field-fixture";
import { fieldNetwork } from "./support/field-network";
import { storedFieldData } from "./support/field-storage";

test.use({ serviceWorkers: "allow", channel: "chromium" });
for (const locale of ["en", "fr", "ar"] as const) test(`An expired photo transport recovers its original offline bytes and operation in ${locale}`, async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required for photo recovery"); test.setTimeout(180000); expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page;
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined, network: Awaited<ReturnType<typeof fieldNetwork>> | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const f = await openFieldFixture(page, info, locale); fixture = f;
    network = await fieldNetwork(native.context, "hold");
    const bytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Capture fixture unavailable");
      context.fillStyle = "#408060"; context.fillRect(0, 0, 32, 32); const value = canvas.toDataURL("image/png").split(",")[1];
      if (!value) throw new Error("Capture fixture encoding unavailable"); return value;
    }), "base64");
    await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
    await native.context.setOffline(true);
    const capture = page.getByTestId("field-photo");
    await capture.getByTestId("field-photo-file").setInputFiles({ name: "retained.png", mimeType: "image/png", buffer: bytes });
    await capture.getByTestId("field-photo-note").fill("Retain the original capture after transport expiry"); await capture.getByTestId("field-photo-save").click();
    await expect(capture.getByTestId("field-photo-queued")).toBeVisible();
    const original = z.array(z.object({ organizationId: z.uuid(), userId: z.uuid(), deviceId: z.uuid(), operation: z.object({ client_op_id: z.uuid(), type: z.literal("field_photo.prepare") }) })).length(1).parse(await storedFieldData(page))[0];
    const photo = z.array(z.object({ manifest: fieldUploadManifestSchema })).length(1).parse(await storedFieldData(page, "photos"))[0];
    const readCapture = async () => Buffer.from(await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("alvillas.field.v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Native database unavailable")); });
      try {
        const rows = await new Promise<Array<{ blob: Blob }>>((resolve, reject) => { const request = db.transaction("photos").objectStore("photos").getAll(); request.onsuccess = () => resolve(request.result as Array<{ blob: Blob }>); request.onerror = () => reject(new Error("Native capture unavailable")); });
        if (rows.length !== 1) throw new Error("One original capture required"); return Array.from(new Uint8Array(await rows[0].blob.arrayBuffer()));
      } finally { db.close(); }
    }));
    const originalCapture = await readCapture();
    expect(photo.manifest.sha256).toBe(createHash("sha256").update(originalCapture).digest("hex")); expect(photo.manifest.size).toBe(originalCapture.length);
    // Arrange historical expired transport with no issued signatures or stored parts.
    // Policy/clock/lease decisions and expiry races are exercised by PostgreSQL tests;
    // this browser journey verifies actual authorized recovery, upload and safe retry.
    const upload = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }), past = new Date(Date.now() - 86_400_000);
      expect(task.assignedToUserAccountId).toBe(original.userId);
      const rule = await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: fieldUploadLifecycleKey, scopeType: "property", scopeId: task.propertyId,
        effectiveFrom: new Date("2020-01-01"), value: { openUploadIdleAfterMinutes: 1 }, reason: "Photo recovery acceptance policy" });
      const row = await tx.operationEvidenceUpload.create({ data: { organizationId: f.organizationId, actorId: original.userId, taskId: f.taskId,
        deviceId: original.deviceId, localId: photo.manifest.localId, manifest: photo.manifest,
        manifestHash: operationHash({ deviceId: original.deviceId, manifest: photo.manifest }), createdAt: past, updatedAt: past, lastActivityAt: past, lifecycleCheckedAt: past } });
      return tx.operationEvidenceUpload.update({ where: { id: row.id }, data: { status: "CANCELLED", expiredAt: new Date(past.getTime() + 60_000),
        expiryPolicy: { openUploadIdleAfterMinutes: 1, configRuleId: rule.id, configVersion: rule.version }, updatedAt: new Date(past.getTime() + 60_000) } });
    });
    const cleanup = z.object({ cleaned: z.literal(1), deletedIndices: z.array(z.number().int().nonnegative()) }).parse(JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", "tests/e2e/support/field-upload-cleanup.ts"], { input: JSON.stringify({ organizationId: f.organizationId, uploadId: upload.id }), encoding: "utf8" })));
    expect(cleanup.cleaned).toBe(1); expect(cleanup.deletedIndices.sort((a, b) => a - b)).toEqual(photo.manifest.parts.map((_, index) => index));
    await page.reload(); await expect(capture.getByTestId("field-photo-queued")).toBeVisible();
    expect(await readCapture()).toEqual(originalCapture);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await native.context.setOffline(false);
    const recoveredPhoto = z.array(z.object({ generation: z.number().optional(), uploadId: z.uuid().optional(), ready: z.boolean(), uploadedParts: z.array(z.number()) }));
    await expect.poll(async () => recoveredPhoto.parse(await storedFieldData(page, "photos"))[0], { timeout: 30000 }).toMatchObject({ generation: 2, uploadId: upload.id, ready: true,
      uploadedParts: photo.manifest.parts.map((_, index) => index) });
    await expect.poll(async () => (await network!.state()).heldResponses.some(row => row.results.includes("APPLIED"))).toBe(true);
    await expect(page.getByTestId("field-sync-now")).toBeDisabled();
    const retained = z.array(z.object({ deviceId: z.uuid(), operation: z.object({ client_op_id: z.uuid(), type: z.string() }) })).parse(await storedFieldData(page));
    expect(retained).toHaveLength(1); expect(retained[0]).toMatchObject({ deviceId: original.deviceId, operation: { client_op_id: original.operation.client_op_id, type: "field_task.evidence.attach" } });
    await native.context.setOffline(true); await page.reload(); await expect(capture.getByTestId("field-photo-queued")).toBeVisible();
    await network.release(); await native.context.setOffline(false);
    await expect.poll(() => storedFieldData(page)).toEqual([]); await expect.poll(() => storedFieldData(page, "photos")).toEqual([]);
    await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({ generation: 2, status: "ATTACHED", deviceId: original.deviceId,
        localId: original.operation.client_op_id, manifest: photo.manifest, expiredAt: null, expiryPolicy: null });
      expect(await tx.syncOp.count({ where: { deviceId: original.deviceId, clientOpId: original.operation.client_op_id, status: "APPLIED" } })).toBe(1);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.taskId, sha256: photo.manifest.sha256, size: originalCapture.length } })).toBe(1);
      for (const action of ["task.photo.upload.recovered", "task.photo.upload.ready", "task.evidence.attached"]) expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.complete" } })).toBe(0);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).state).toBe("ASSIGNED");
    });
    expect(errors).toEqual([]);
  } finally { await network?.close(); await fixture?.db.$disconnect(); await native.close(); }
});
