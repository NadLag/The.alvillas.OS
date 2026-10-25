import "fake-indexeddb/auto";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldQueue } from "@/platform/offline/field-queue";
import { prepareQueuedPhoto } from "@/platform/offline/field-photo-sync";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";

const stores: FieldQueue[] = [];
const requestUrl = (request: Parameters<typeof fetch>[0]) => new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, "https://example.test");
function requestJson(options?: RequestInit): unknown { if (typeof options?.body !== "string") throw Error("Expected a JSON request body"); return JSON.parse(options.body) as unknown; }
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.delete())); });
async function fixture() {
  const queue = new FieldQueue(`photo-generation-${randomUUID()}`); stores.push(queue);
  const scope = { organizationId: randomUUID(), userId: randomUUID() }, stamp = new Date().toISOString();
  const task: FieldWorkSnapshot = { id: randomUUID(), propertyId: randomUUID(), propertyName: "Assigned villa", propertyAddress: "Operational address",
    propertyTimezone: "Africa/Casablanca", reservationReference: null, title: { en: "Inspect" }, type: "INSPECTION", state: "ASSIGNED", priority: "NORMAL",
    dueDate: "2026-10-24", businessDate: "2026-10-24", serverVersion: stamp, revision: "A".repeat(43), canEdit: true, checklistItems: [] };
  await queue.activate(scope); const state = await queue.prepareCache(scope);
  await queue.publishCache(scope, state, [task], [], "checkpoint", stamp);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const localId = randomUUID(), uploadId = randomUUID(), manifest = { protocolVersion: 1, localId, taskId: task.id, note: "Original retained capture",
    contentType: "image/png", size: bytes.length, sha256, parts: [{ size: bytes.length, sha256 }] };
  await queue.enqueuePhoto(scope, manifest, new Blob([bytes], { type: "image/png" }), state.incarnation);
  await queue.updatePhoto(scope, localId, state.incarnation, { uploadId });
  await queue.updatePhoto(scope, localId, state.incarnation, { uploadedPart: 0 });
  return { queue, scope, state, localId, uploadId, bytes, original: structuredClone((await queue.entries(scope))[0]) };
}

describe("durable photo generation recovery", () => {
  it("fences late part and ready acknowledgements while preserving the original blob, device and business operation", async () => {
    const f = await fixture(), { queue, scope, localId, state } = f;
    expect(await queue.updatePhoto(scope, localId, state.incarnation, { generation: 2, uploadId: f.uploadId })).toBe(true);
    expect((await queue.photos.toArray())[0]).toMatchObject({ generation: 2, uploadedParts: [], ready: false });
    expect(await queue.updatePhoto(scope, localId, state.incarnation, { uploadedPart: 0 }, { expectedGeneration: 1 })).toBe(false);
    expect(await queue.updatePhoto(scope, localId, state.incarnation, { ready: true }, { expectedGeneration: 1 })).toBe(false);
    expect(await queue.updatePhoto(scope, localId, state.incarnation, { generation: 1 })).toBe(false);
    expect((await queue.photos.toArray())[0]).toMatchObject({ generation: 2, uploadedParts: [], ready: false });
    expect(await queue.entries(scope)).toEqual([f.original]);
    expect(Buffer.from(await (await queue.photos.toArray())[0].blob.arrayBuffer())).toEqual(f.bytes);
    expect(await queue.updatePhoto(scope, localId, state.incarnation, { uploadedPart: 0 }, { expectedGeneration: 2 })).toBe(true);
    expect(await queue.updatePhoto(scope, localId, state.incarnation, { ready: true }, { expectedGeneration: 2 })).toBe(true);
  });
  it("retransmits every original byte after recovery instead of trusting the old generation's part acknowledgement", async () => {
    const f = await fixture(), sent: Buffer[] = [];
    const send = vi.fn<typeof fetch>(async (request, options) => {
      const url = requestUrl(request);
      if (url.pathname === "/api/field/uploads") {
        expect(requestJson(options)).toMatchObject({ include_generation: true });
        return Response.json({ uploadId: f.uploadId, status: "OPEN", generation: 2 });
      }
      if (url.pathname === "/api/field/uploads/part") {
        expect(url.searchParams.get("generation")).toBe("2"); expect(options?.body).toBeInstanceOf(Blob);
        const body = options?.body; if (!(body instanceof Blob)) throw Error("Expected the original photo part");
        sent.push(Buffer.from(await body.arrayBuffer())); return Response.json({ stored: true });
      }
      expect(url.pathname).toBe("/api/field/uploads/complete"); expect(requestJson(options)).toMatchObject({ generation: 2 });
      return Response.json({ uploadId: f.uploadId, status: "READY", generation: 2 });
    });
    expect(await prepareQueuedPhoto(f.queue, f.scope, f.original, send)).toEqual(f.original);
    expect(sent).toEqual([f.bytes]); expect((await f.queue.photos.toArray())[0]).toMatchObject({ generation: 2, ready: true, uploadedParts: [0] });
    expect(await f.queue.entries(f.scope)).toEqual([f.original]);
  });
  it("retries only the explicit generation-change transport response and retains unrelated conflicts for review", async () => {
    for (const error of ["upload_generation_changed", "upload_idempotency_key_reused"]) {
      const f = await fixture(); await f.queue.photos.update((await f.queue.photos.toArray())[0].cacheId, { uploadedParts: [] });
      const send = vi.fn<typeof fetch>(request => Promise.resolve(requestUrl(request).pathname === "/api/field/uploads"
        ? Response.json({ uploadId: f.uploadId, status: "OPEN", generation: 1 }) : Response.json({ error }, { status: 409 })));
      expect(await prepareQueuedPhoto(f.queue, f.scope, f.original, send, () => 10000)).toBe(error === "upload_generation_changed" ? "queued" : "rejected");
      expect((await f.queue.entries(f.scope))[0].syncStatus).toBe(error === "upload_generation_changed" ? "pending" : "conflict");
      expect((await f.queue.photos.toArray())[0].blob.size).toBe(f.bytes.length);
    }
  });
});
