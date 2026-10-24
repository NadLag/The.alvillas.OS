import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";

test.use({ serviceWorkers: "allow" });
test("Field photo endpoints authenticate ownership, enforce private responses and reject forged requests before storage", async ({ page, playwright }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for authenticated photo endpoints"); test.setTimeout(180000);
  const f = await openFieldFixture(page, info, "en"), origin = new URL(page.url()).origin;
  const anonymous = await playwright.request.newContext({ baseURL: origin });
  try {
    const session = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json());
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64"), digest = createHash("sha256").update(bytes).digest("hex");
    const input = { organization_id: f.organizationId, actor_user_id: session.user.id, device_id: randomUUID(), manifest: {
      protocolVersion: 1, localId: randomUUID(), taskId: f.taskId, contentType: "image/png", note: "Retained field photo", size: bytes.length,
      sha256: digest, parts: [{ size: bytes.length, sha256: digest }] } };
    const post = (value: unknown, requestOrigin = origin) => page.request.post("/api/field/uploads", { data: value, headers: { Origin: requestOrigin } });
    for (const path of ["/api/field/uploads", "/api/field/uploads/complete"]) {
      const response = await anonymous.post(path, { data: input, headers: { Origin: origin } }); expect(response.status()).toBe(401);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
    }
    expect((await anonymous.put("/api/field/uploads/part", { data: bytes, headers: { Origin: origin, "Content-Type": "application/octet-stream" } })).status()).toBe(401);
    expect((await post(input, "https://other.example.test")).status()).toBe(403);
    expect((await page.request.post("/api/field/uploads", { data: JSON.stringify(input), headers: { Origin: origin, "Content-Type": "text/plain" } })).status()).toBe(403);
    expect((await post({ ...input, actor_user_id: randomUUID() })).status()).toBe(403);
    expect((await post({ ...input, organization_id: randomUUID() })).status()).toBe(403);
    expect((await post({ ...input, manifest: { ...input.manifest, parts: [] } })).status()).toBe(400);
    expect((await post({ ...input, unexpected: "x".repeat(70000) })).status()).toBe(400);
    const responses = await Promise.all([post(input), post(input)]);
    for (const response of responses) { expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie"); }
    const resultSchema = z.object({ uploadId: z.uuid(), status: z.literal("OPEN") }).strict();
    const result = resultSchema.parse(await responses[0].json()); expect(resultSchema.parse(await responses[1].json())).toEqual(result);
    const forged = { organization_id: f.organizationId, actor_user_id: session.user.id, device_id: randomUUID(), uploadId: result.uploadId };
    const query = new URLSearchParams({ ...forged, index: "0" });
    expect((await page.request.put(`/api/field/uploads/part?${query}`, { data: bytes, headers: { Origin: origin, "Content-Type": "application/octet-stream" } })).status()).toBe(404);
    expect((await page.request.post("/api/field/uploads/complete", { data: forged, headers: { Origin: origin } })).status()).toBe(404);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.operationEvidenceUpload.count({ where: { taskId: f.taskId } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.photo.upload.started" } })).toBe(1);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: f.taskId } })).toBe(0);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).state).toBe("ASSIGNED");
    });
  } finally { await anonymous.dispose(); await f.db.$disconnect(); }
});
