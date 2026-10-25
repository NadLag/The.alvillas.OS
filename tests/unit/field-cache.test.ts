import "fake-indexeddb/auto";
import Dexie from "dexie";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldQueue, syncFieldQueue } from "@/platform/offline/field-queue";
import { fieldUploadChunkBytes, type FieldUploadManifest } from "@/modules/reservations/domain/field-upload";
import { fieldIdentity, type FieldCacheState, type FieldCachedJob, type FieldDraft, type FieldQueueEntry, type FieldQueueScope } from "@/platform/offline/field-queue-store";
import { refreshFieldCache } from "@/platform/offline/field-pull";
import { resolveFieldScope } from "@/platform/offline/field-session";
import { prepareQueuedPhoto } from "@/platform/offline/field-photo-sync";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";

const stores: FieldQueue[] = [], scope: FieldQueueScope = { organizationId: randomUUID(), userId: randomUUID() };
const stamp = new Date().toISOString(), revision = "A".repeat(43);
function job(): FieldWorkSnapshot { return { id: randomUUID(), propertyId: randomUUID(), propertyName: "Operational villa", propertyAddress: "Test",
  propertyTimezone: "Africa/Casablanca", reservationReference: null, title: { en: "Inspect" }, type: "INSPECTION", state: "ASSIGNED", priority: "NORMAL",
  dueDate: "2026-10-23", businessDate: "2026-10-23", serverVersion: stamp, revision, canEdit: true,
  checklistItems: [{ id: randomUUID(), key: "ready", label: { en: "Ready" }, completed: false }] }; }
async function setup() { const queue = new FieldQueue(`cache-${randomUUID()}`); stores.push(queue); await queue.activate(scope); return queue; }
function result(tasks: FieldWorkSnapshot[], extra = {}) { return Response.json({ op_schema_version: 1, organization_id: scope.organizationId,
  actor_user_id: scope.userId, snapshot_at: stamp, cursor: "checkpoint", next_cursor: null, tasks, known_changes: [], tombstones: [], ...extra }); }
async function publish(queue: FieldQueue, owner: FieldQueueScope, generation: number, tasks: FieldWorkSnapshot[], removed: string[], cursor: string, snapshotAt: string) {
  const state = (await queue.readCache(owner)).state!;
  return queue.publishCache(owner, { incarnation: state.incarnation, generation }, tasks, removed, cursor, snapshotAt);
}
async function draft(queue: FieldQueue, owner: FieldQueueScope, taskId: string, ids: string[], note: string) {
  return queue.saveDraft(owner, taskId, ids, note, (await queue.readCache(owner)).state!.incarnation);
}
const requestUrl = (input: Parameters<typeof fetch>[0]) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://example.test");
function photo(task: FieldWorkSnapshot) {
  const bytes = Buffer.alloc(fieldUploadChunkBytes + 19, 0x5a);
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64").copy(bytes);
  const manifest: FieldUploadManifest = { protocolVersion: 1, localId: randomUUID(), taskId: task.id, contentType: "image/png", note: "Captured photo retained",
    size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), parts: [bytes.subarray(0, fieldUploadChunkBytes), bytes.subarray(fieldUploadChunkBytes)]
      .map(part => ({ size: part.length, sha256: createHash("sha256").update(part).digest("hex") })) };
  return { manifest, bytes, blob: new Blob([bytes], { type: "image/png" }) };
}
function photoSend(handler: (url: URL, options?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>((input, options) => Promise.resolve().then(() => handler(requestUrl(input), options)));
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.delete())); });
describe("field work cache", () => {
  it("retains completion behind rejected evidence while allowing unrelated queued work to synchronize", async () => {
    const queue = await setup(), task = job(), other = job(), capture = photo(task);
    await publish(queue, scope, 0, [task, other], [], "photos-review", stamp);
    await queue.enqueuePhoto(scope, capture.manifest, capture.blob, (await queue.readCache(scope)).state!.incarnation);
    const completion = await queue.enqueue(scope, { client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: task.id, checklistItemIds: [task.checklistItems[0].id] } });
    const unrelated = await queue.enqueue(scope, { client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: other.id, checklistItemIds: [other.checklistItems[0].id] } });
    const sent: string[] = [];
    const send = photoSend((url, options) => {
      if (url.pathname === "/api/field/uploads") return Response.json({ error: "forbidden" }, { status: 403 });
      if (typeof options?.body !== "string") throw Error("Expected a JSON sync request body");
      const input = syncPushInputSchema.parse(JSON.parse(options.body)); sent.push(input.ops[0].client_op_id);
      return Response.json({ op_schema_version: 1, results: [{ client_op_id: input.ops[0].client_op_id, status: "APPLIED", server_version: null }] });
    });
    expect(await syncFieldQueue(queue, scope, send)).toBe("rejected");
    await syncFieldQueue(queue, scope, send); expect(sent).toEqual([unrelated.operation.client_op_id]);
    expect((await queue.entries(scope)).map(entry => ({ id: entry.operation.client_op_id, status: entry.syncStatus }))).toEqual([
      { id: capture.manifest.localId, status: "rejected" }, { id: completion.operation.client_op_id, status: "pending" }
    ]);
    expect(await queue.photos.count()).toBe(1); expect(await queue.cachedJobs(scope)).toEqual([task]);
  });
  it("upgrades a populated v2 device without losing its owner, original completion, draft or pull cursor", async () => {
    const name = `upgrade-${randomUUID()}`, legacy = new Dexie(name), task = job(), identity = fieldIdentity(scope), cacheId = `${identity}:${task.id}`;
    legacy.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
    legacy.version(2).stores({ jobs: "&cacheId,[organizationId+userId]", drafts: "&cacheId,[organizationId+userId]", cacheState: "key" });
    const deviceId = randomUUID(), state: FieldCacheState = { ...scope, key: identity, incarnation: randomUUID(), generation: 7, snapshotAt: stamp, cursor: "v2-private-cursor" };
    const saved: FieldDraft = { ...scope, cacheId, taskId: task.id, checklistItemIds: [task.checklistItems[0].id], note: "Retained before photo update", savedAt: stamp };
    const entry: FieldQueueEntry = { ...scope, localId: `${identity}:${randomUUID()}`, sequence: 12, deviceId, syncStatus: "pending", operation: {
      client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: task.id, checklistItemIds: saved.checklistItemIds, note: saved.note }
    } };
    entry.localId = `${identity}:${entry.operation.client_op_id}`;
    try {
      await legacy.table<{ key: string; value: string }, string>("metadata").bulkPut([{ key: "identity", value: identity }, { key: "device", value: deviceId }]);
      await legacy.table<FieldCachedJob, string>("jobs").put({ ...scope, cacheId, task });
      await legacy.table<FieldDraft, string>("drafts").put(saved); await legacy.table<FieldCacheState, string>("cacheState").put(state);
      await legacy.table<FieldQueueEntry, number>("operations").put(entry);
    } finally { legacy.close(); }
    const queue = new FieldQueue(name); stores.push(queue); await queue.activate(scope);
    expect(queue.verno).toBe(5); expect((await queue.metadata.get("device"))?.value).toBe(deviceId); expect(await queue.entries(scope)).toEqual([entry]);
    expect(await queue.proxyJobs.count()).toBe(0); expect(await queue.proxyDrafts.count()).toBe(0);
    expect(await queue.cachedJobs(scope)).toEqual([task]); expect(await queue.drafts.get(cacheId)).toEqual(saved);
    expect((await queue.readCache(scope)).state).toEqual(state); expect(await queue.photos.count()).toBe(0);
    expect((await queue.photoSnapshot(scope, task.id)).canEdit).toBe(false);
    expect(await queue.acknowledge(scope, entry, { client_op_id: entry.operation.client_op_id, status: "APPLIED", server_version: null })).toBe(true);
    expect(await queue.entries(scope)).toEqual([]); expect(await queue.cachedJobs(scope)).toEqual([]); expect(await queue.drafts.count()).toBe(0);
  });
  it("atomically persists photo bytes and the original ordered operation across reopening", async () => {
    const queue = await setup(), task = job(), capture = photo(task);
    await publish(queue, scope, 0, [task], [], "cursor", stamp);
    const incarnation = (await queue.readCache(scope)).state!.incarnation;
    const entries = await Promise.all([queue.storePhoto(scope, capture.manifest, capture.blob, incarnation), queue.storePhoto(scope, capture.manifest, capture.blob, incarnation)]);
    expect(entries[0].sequence).toBe(entries[1].sequence);
    queue.close(); const reopened = new FieldQueue(queue.name); stores.splice(stores.indexOf(queue), 1, reopened);
    const saved = await reopened.photos.get(`${fieldIdentity(scope)}:${capture.manifest.localId}`);
    expect(saved).toMatchObject({ manifest: capture.manifest, incarnation, uploadedParts: [], ready: false });
    expect(Buffer.from(await saved!.blob.arrayBuffer())).toEqual(capture.bytes);
    expect(await reopened.entries(scope)).toEqual([entries[0]]);
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    expect(await syncFieldQueue(reopened, scope, send)).toBe("queued"); expect(send.mock.calls.map(call => call[0])).toEqual(["/api/field/uploads"]);
    await expect(reopened.storePhoto(scope, { ...capture.manifest, note: "Replaced original photo" }, capture.blob, incarnation)).rejects.toThrow("FIELD_PHOTO_KEY_REUSED");
  });
  it("binds a server upload once, retains partial progress and acknowledges evidence without completing the task", async () => {
    const queue = await setup(), task = job(), capture = photo(task), uploadId = randomUUID();
    await publish(queue, scope, 0, [task], [], "cursor", stamp); await draft(queue, scope, task.id, [], "Checklist remains unfinished");
    const incarnation = (await queue.readCache(scope)).state!.incarnation;
    const original = await queue.storePhoto(scope, capture.manifest, capture.blob, incarnation);
    await queue.updatePhoto(scope, capture.manifest.localId, incarnation, { uploadId, uploadedPart: 0 });
    await expect(queue.updatePhoto(scope, capture.manifest.localId, incarnation, { uploadId: randomUUID() })).rejects.toThrow("FIELD_PHOTO_KEY_REUSED");
    const entry = (await queue.entries(scope))[0]; expect(entry.sequence).toBe(original.sequence); expect(entry.deviceId).toBe(original.deviceId);
    expect(entry.operation).toMatchObject({ type: "field_task.evidence.attach", client_op_id: capture.manifest.localId, payload: { uploadId, taskId: task.id } });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(Response.json({ op_schema_version: 1, results: [{ client_op_id: capture.manifest.localId, status: "APPLIED", server_version: null }] }));
    expect(await syncFieldQueue(queue, scope, send)).toBe("queued"); expect(send.mock.calls.map(call => call[0])).toEqual(["/api/field/uploads"]);
    expect((await queue.photos.toArray())[0].uploadedParts).toEqual([0]);
    await queue.updatePhoto(scope, capture.manifest.localId, incarnation, { uploadedPart: 1, ready: true });
    send.mockClear();
    const acknowledged = vi.fn<() => Promise<void>>().mockResolvedValue();
    expect(await syncFieldQueue(queue, scope, send, acknowledged)).toBe("synced");
    expect(send).toHaveBeenCalledTimes(1); expect(acknowledged).not.toHaveBeenCalled();
    expect(await queue.photos.count()).toBe(0); expect(await queue.entries(scope)).toEqual([]);
    expect(await queue.cachedJobs(scope)).toEqual([task]); expect((await queue.readDraft(scope, task.id))?.note).toBe("Checklist remains unfinished");
  });
  it("rolls back photo bytes and ordering together after quota failure", async () => {
    const queue = await setup(), task = job(), capture = photo(task);
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const incarnation = (await queue.readCache(scope)).state!.incarnation;
    vi.spyOn(queue.photos, "add").mockRejectedValueOnce(new DOMException("Quota exhausted", "QuotaExceededError"));
    await expect(queue.storePhoto(scope, capture.manifest, capture.blob, incarnation)).rejects.toThrow("Quota exhausted");
    expect(await queue.photos.count()).toBe(0); expect(await queue.entries(scope)).toEqual([]);
    await queue.storePhoto(scope, capture.manifest, capture.blob, incarnation);
    expect(await queue.photos.count()).toBe(1); expect(await queue.entries(scope)).toHaveLength(1);
  });
  it("rejects late photo callbacks after logout and a fresh sign-in by the same account", async () => {
    const queue = await setup(), task = job(), capture = photo(task);
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const before = (await queue.readCache(scope)).state!.incarnation;
    await queue.storePhoto(scope, capture.manifest, capture.blob, before); await queue.wipe(scope); await queue.activate(scope);
    await publish(queue, scope, 0, [task], [], "new-cursor", stamp); const after = (await queue.readCache(scope)).state!.incarnation;
    await queue.storePhoto(scope, capture.manifest, capture.blob, after);
    expect(await queue.updatePhoto(scope, capture.manifest.localId, before, { uploadId: randomUUID(), uploadedPart: 0, ready: true })).toBe(false);
    expect((await queue.photos.toArray())[0]).toMatchObject({ incarnation: after, ready: false, uploadedParts: [] });
    expect((await queue.entries(scope))[0].operation.type).toBe("field_photo.prepare");
  });
  it("wipes private photo bytes on account or tenant changes and blocks stale capture callbacks", async () => {
    const queue = await setup(), task = job(), capture = photo(task), other = { organizationId: randomUUID(), userId: randomUUID() };
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const incarnation = (await queue.readCache(scope)).state!.incarnation;
    await queue.storePhoto(scope, capture.manifest, capture.blob, incarnation); await queue.activate(other);
    expect(await queue.photos.count()).toBe(0); expect(await queue.operations.count()).toBe(0);
    expect(await queue.updatePhoto(scope, capture.manifest.localId, incarnation, { uploadedPart: 0 })).toBe(false);
    await expect(queue.storePhoto(scope, capture.manifest, capture.blob, incarnation)).rejects.toThrow("FIELD_SESSION_CHANGED");
  });
  it("resumes only unacknowledged photo chunks with backoff and retries the original business operation after a lost acknowledgement", async () => {
    const queue = await setup(), task = job(), capture = photo(task), uploadId = randomUUID();
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const incarnation = (await queue.readCache(scope)).state!.incarnation;
    const original = await queue.storePhoto(scope, capture.manifest, capture.blob, incarnation), partCalls = [0, 0], wire: unknown[] = [];
    let clock = 1000, losePart = true, loseBusiness = true, completionCount = 0;
    const send = photoSend(async (url, options) => {
      if (url.pathname === "/api/field/uploads") return Response.json({ uploadId, status: "OPEN" });
      if (url.pathname === "/api/field/uploads/part") {
        const index = Number(url.searchParams.get("index")); partCalls[index]++;
        expect(options?.body).toBeInstanceOf(Blob);
        const from = index ? fieldUploadChunkBytes : 0;
        expect(Buffer.from(await (options!.body as Blob).arrayBuffer())).toEqual(capture.bytes.subarray(from, from + capture.manifest.parts[index].size));
        if (index === 1 && losePart) { losePart = false; throw Error("Lost part acknowledgement"); }
        return Response.json({ stored: true });
      }
      if (url.pathname === "/api/field/uploads/complete") return Response.json({ uploadId, status: "READY" });
      if (url.pathname !== "/api/sync/push" || typeof options?.body !== "string") throw Error("Unexpected photo request");
      const payload = syncPushInputSchema.parse(JSON.parse(options.body) as unknown); wire.push(payload);
      expect(payload.ops[0]).toMatchObject({ client_op_id: original.operation.client_op_id, type: "field_task.evidence.attach", payload: { uploadId, taskId: task.id } });
      if (loseBusiness) { loseBusiness = false; completionCount++; throw Error("Lost business acknowledgement"); }
      return Response.json({ op_schema_version: 1, results: [{ client_op_id: original.operation.client_op_id, status: "DUPLICATE", server_version: null }] });
    });
    expect(await prepareQueuedPhoto(queue, scope, original, send, () => clock)).toBe("queued");
    expect((await queue.photos.toArray())[0]).toMatchObject({ uploadedParts: [0], attempts: 1, retryAt: 2000 });
    const requests = send.mock.calls.length; clock = 1500;
    expect(await prepareQueuedPhoto(queue, scope, original, send, () => clock)).toBe("queued"); expect(send).toHaveBeenCalledTimes(requests);
    clock = 2000; const prepared = await prepareQueuedPhoto(queue, scope, original, send, () => clock);
    expect(prepared).toMatchObject({ deviceId: original.deviceId, sequence: original.sequence, operation: { client_op_id: original.operation.client_op_id } });
    expect(partCalls).toEqual([1, 2]); expect(await syncFieldQueue(queue, scope, send)).toBe("queued");
    expect((await queue.photos.toArray())[0].ready).toBe(true); expect(await syncFieldQueue(queue, scope, send)).toBe("synced");
    expect(wire).toHaveLength(2); expect(wire[0]).toEqual(wire[1]); expect(completionCount).toBe(1);
    expect(await queue.photos.count()).toBe(0); expect(await queue.entries(scope)).toEqual([]); expect(await queue.cachedJobs(scope)).toEqual([task]);
  });
  it("recovers a lost upload-completion acknowledgement without retransmitting acknowledged chunks", async () => {
    const queue = await setup(), task = job(), capture = photo(task), uploadId = randomUUID();
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const incarnation = (await queue.readCache(scope)).state!.incarnation;
    const entry = await queue.storePhoto(scope, capture.manifest, capture.blob, incarnation); let ready = false, parts = 0, completed = 0;
    const send = photoSend(url => {
      if (url.pathname === "/api/field/uploads") return Response.json({ uploadId, status: ready ? "READY" : "OPEN" });
      if (url.pathname === "/api/field/uploads/part") { parts++; return Response.json({ stored: true }); }
      ready = true; completed++; throw Error("Lost completion acknowledgement");
    });
    expect(await prepareQueuedPhoto(queue, scope, entry, send, () => 1000)).toBe("queued");
    expect(await prepareQueuedPhoto(queue, scope, entry, send, () => 2000)).toMatchObject({ operation: { type: "field_task.evidence.attach" } });
    expect(parts).toBe(2); expect(completed).toBe(1); expect((await queue.photos.toArray())[0]).toMatchObject({ ready: true, attempts: 0, retryAt: 0 });
  });
  it("preserves captured evidence and original keys for review when upload authorization is rejected", async () => {
    const queue = await setup(), task = job(), capture = photo(task);
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const incarnation = (await queue.readCache(scope)).state!.incarnation;
    const entry = await queue.storePhoto(scope, capture.manifest, capture.blob, incarnation), send = photoSend(() => new Response(null, { status: 403 }));
    expect(await prepareQueuedPhoto(queue, scope, entry, send)).toBe("rejected");
    expect((await queue.entries(scope))[0]).toMatchObject({ deviceId: entry.deviceId, syncStatus: "rejected", operation: { client_op_id: entry.operation.client_op_id }, result: { error_code: "REJECTED_FORBIDDEN" } });
    expect(Buffer.from(await (await queue.photos.toArray())[0].blob.arrayBuffer())).toEqual(capture.bytes);
    send.mockClear(); expect(await syncFieldQueue(queue, scope, send)).toBe("rejected"); expect(send).not.toHaveBeenCalled();
  });
  it("does not wipe fresh photo work when an old session's upload response arrives late", async () => {
    const queue = await setup(), task = job(), capture = photo(task);
    await publish(queue, scope, 0, [task], [], "cursor", stamp); const before = (await queue.readCache(scope)).state!.incarnation;
    const entry = await queue.storePhoto(scope, capture.manifest, capture.blob, before);
    let respond!: (value: Response) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const send = vi.fn<typeof fetch>(() => { began(); return new Promise(resolve => { respond = resolve; }); });
    const pending = prepareQueuedPhoto(queue, scope, entry, send); await started;
    await queue.wipe(scope); await queue.activate(scope); await publish(queue, scope, 0, [task], [], "new-cursor", stamp);
    const after = (await queue.readCache(scope)).state!.incarnation; await queue.storePhoto(scope, capture.manifest, capture.blob, after);
    respond(new Response(null, { status: 401 })); expect(await pending).toBe("rejected");
    expect((await queue.photos.toArray())[0].incarnation).toBe(after); expect(await queue.entries(scope)).toHaveLength(1);
  });
  it("acknowledges photo evidence without removing a cached job or its unfinished checklist draft", async () => {
    const queue = await setup(), task = job();
    await publish(queue, scope, 0, [task], [], "cursor", stamp);
    await draft(queue, scope, task.id, [task.checklistItems[0].id], "Checklist work retained");
    const state = (await queue.readCache(scope)).state!;
    const entry = await queue.enqueue(scope, { client_op_id: randomUUID(), type: "field_task.evidence.attach", payload: { taskId: task.id, uploadId: randomUUID() } });
    expect(await queue.acknowledge(scope, entry, { client_op_id: entry.operation.client_op_id, status: "APPLIED", server_version: null })).toBe(true);
    expect(await queue.entries(scope)).toEqual([]);
    expect(await queue.cachedJobs(scope)).toEqual([task]);
    expect((await queue.readDraft(scope, task.id))?.note).toBe("Checklist work retained");
    expect((await queue.readCache(scope)).state).toEqual(state);
  });
  it("rejects late pulls and drafts after logout and sign-in by the same account", async () => {
    const queue = await setup(), old = (await queue.readCache(scope)).state!, task = job();
    await queue.wipe(scope); await queue.activate(scope);
    const fresh = (await queue.readCache(scope)).state!;
    expect(fresh.incarnation).not.toBe(old.incarnation); expect(fresh.generation).toBe(old.generation);
    expect(await queue.publishCache(scope, old, [task], [], "stale", stamp)).toBe(false);
    await expect(queue.saveDraft(scope, task.id, [], "Old draft", old.incarnation)).rejects.toThrow("FIELD_SESSION_CHANGED");
    expect(await queue.cachedJobs(scope)).toEqual([]); expect(await queue.drafts.count()).toBe(0);
  });
  it("upgrades the existing database without changing queued keys, device or review evidence", async () => {
    const name = `cache-upgrade-${randomUUID()}`, old = new Dexie(name), task = job();
    old.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
    const operation = { client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: task.id, checklistItemIds: [task.checklistItems[0].id], note: "Retained evidence" } };
    await old.table("metadata").bulkPut([{ key: "identity", value: fieldIdentity(scope) }, { key: "device", value: "original-device" }]);
    await old.table("operations").add({ ...scope, localId: `${fieldIdentity(scope)}:${operation.client_op_id}`, operation, deviceId: "original-device", syncStatus: "conflict" });
    old.close(); const queue = new FieldQueue(name); stores.push(queue); await queue.activate(scope);
    expect((await queue.entries(scope))[0]).toMatchObject({ operation, deviceId: "original-device", syncStatus: "conflict" });
    expect((await queue.metadata.get("device"))?.value).toBe("original-device"); expect(await queue.cachedJobs(scope)).toEqual([]);
  });

  it("atomically removes acknowledged jobs and drafts and prevents an in-flight pull from restoring them", async () => {
    const queue = await setup(), task = job();
    await publish(queue, scope, 0, [task], [], "old-checkpoint", stamp); await draft(queue, scope, task.id, [task.checklistItems[0].id], "Retained note");
    const op = await queue.enqueue(scope, { client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: task.id, checklistItemIds: [task.checklistItems[0].id] } });
    const before = await queue.readCache(scope);
    await queue.acknowledge(scope, op, { client_op_id: op.operation.client_op_id, status: "DUPLICATE", server_version: "2", error_code: "DUPLICATE_COMPLETION" });
    expect(await publish(queue, scope, before.state!.generation, [task], [], "late-checkpoint", stamp)).toBe(false);
    expect(await queue.cachedJobs(scope)).toEqual([]); expect(await queue.readDraft(scope, task.id)).toBeUndefined(); expect(await queue.entries(scope)).toEqual([]);
    await draft(queue, scope, task.id, [], "Late autosave"); expect(await queue.readDraft(scope, task.id)).toBeUndefined();
  });

  it("wipes cached jobs and drafts on account change or logout and ignores stale-account wipes", async () => {
    const queue = await setup(), task = job(), other = { organizationId: randomUUID(), userId: randomUUID() };
    await publish(queue, scope, 0, [task], [], "cursor", stamp); await draft(queue, scope, task.id, [], "Private note");
    await queue.activate(other); expect(await queue.jobs.count()).toBe(0); expect(await queue.drafts.count()).toBe(0); expect(await queue.cacheState.toArray()).toEqual([expect.objectContaining({ ...other, generation: 0, incarnation: expect.any(String) as string })]);
    const fresh = job(); await publish(queue, other, 0, [fresh], [], "cursor", stamp); await queue.wipe(scope);
    expect(await queue.cachedJobs(other)).toEqual([fresh]); await expect(queue.readCache(scope)).rejects.toThrow("FIELD_SESSION_CHANGED");
    await queue.wipe(); expect(await queue.jobs.count()).toBe(0); expect(await queue.metadata.count()).toBe(0);
  });

  it("retains the previous complete snapshot and pending work after quota failure", async () => {
    const queue = await setup(), task = job(); await publish(queue, scope, 0, [task], [], "old", stamp);
    const op = await queue.enqueue(scope, { client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: task.id, checklistItemIds: [task.checklistItems[0].id] } });
    vi.spyOn(queue.drafts, "bulkDelete").mockRejectedValueOnce(new DOMException("Storage full", "QuotaExceededError"));
    await expect(publish(queue, scope, 1, [job()], [task.id], "new", stamp)).rejects.toThrow("Storage full");
    expect(await queue.cachedJobs(scope)).toEqual([task]); expect((await queue.readCache(scope)).state?.cursor).toBe("old"); expect(await queue.entries(scope)).toEqual([op]);
  });
});

describe("field pull transport", () => {
  it("coalesces refreshes, follows pages and revalidates every remaining known record before publishing", async () => {
    const queue = await setup(), originals = Array.from({ length: 120 }, job), added = job(); await publish(queue, scope, 0, originals, [], "old", stamp);
    const send = vi.fn<typeof fetch>().mockImplementation(url => {
      const params = requestUrl(url).searchParams;
      const index = send.mock.calls.length - 1;
      expect(params.get("organization_id")).toBe(scope.organizationId); expect(params.get("actor_user_id")).toBe(scope.userId);
      expect(params.get("known_tasks")?.split(",")).toHaveLength(index < 2 ? 50 : 20);
      if (!index) { expect(params.has("only_known")).toBe(false); return Promise.resolve(result([added], { cursor: "page1", next_cursor: "page1" })); }
      if (index === 1) { expect(params.get("cursor")).toBe("page1"); expect(params.has("only_known")).toBe(false); return Promise.resolve(result([], { cursor: "checkpoint2" })); }
      expect(params.get("only_known")).toBe("1"); expect(params.get("cursor")).toBe("checkpoint2"); return Promise.resolve(result([], { cursor: "checkpoint3", tombstones: [originals[119].id] }));
    });
    const first = refreshFieldCache(queue, scope, send), second = refreshFieldCache(queue, scope, send); expect(second).toBe(first); await first;
    expect(send).toHaveBeenCalledTimes(3); const cached = await queue.cachedJobs(scope);
    expect(cached).toHaveLength(120); expect(cached.map(row => row.id)).toContain(added.id); expect(cached.map(row => row.id)).not.toContain(originals[119].id);
  });

  it("keeps the entire prior cache when a later page fails and validates returned ownership", async () => {
    const queue = await setup(), original = job(); await publish(queue, scope, 0, [original], [], "old", stamp);
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(result([job()], { cursor: "page1", next_cursor: "page1" })).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(refreshFieldCache(queue, scope, send)).rejects.toThrow("FIELD_PULL_UNAVAILABLE"); expect(await queue.cachedJobs(scope)).toEqual([original]);
    await expect(refreshFieldCache(queue, scope, vi.fn().mockResolvedValue(result([job()], { actor_user_id: randomUUID() })))).rejects.toThrow("FIELD_PULL_OWNER_MISMATCH");
    expect(await queue.cachedJobs(scope)).toEqual([original]);
  });

  it("discards stale scoped cache on cursor reset, retains pending evidence and restarts safely", async () => {
    const queue = await setup(), original = job(), fresh = job(); await publish(queue, scope, 0, [original], [], "old", stamp);
    await queue.enqueue(scope, { client_op_id: randomUUID(), type: "field_task.complete", payload: { taskId: original.id, checklistItemIds: [original.checklistItems[0].id] } });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(result([fresh]));
    await refreshFieldCache(queue, scope, send); expect(await queue.cachedJobs(scope)).toEqual([fresh]); expect(await queue.entries(scope)).toHaveLength(1);
    expect(requestUrl(send.mock.calls[1][0]).searchParams.has("cursor")).toBe(false);
  });

  it("honours session revocation while protecting another account that signs in during the request", async () => {
    const queue = await setup(), task = job(); await publish(queue, scope, 0, [task], [], "old", stamp);
    await expect(refreshFieldCache(queue, scope, vi.fn().mockResolvedValue(new Response(null, { status: 401 })))).rejects.toThrow("FIELD_SESSION_CHANGED");
    expect(await queue.jobs.count()).toBe(0); expect(await queue.metadata.count()).toBe(0);
    await queue.activate(scope); const other = { organizationId: randomUUID(), userId: randomUUID() }, fresh = job();
    const send = vi.fn<typeof fetch>().mockImplementation(async () => { await queue.activate(other); await publish(queue, other, 0, [fresh], [], "new", stamp); return new Response(null, { status: 403 }); });
    await expect(refreshFieldCache(queue, scope, send)).rejects.toThrow("FIELD_SESSION_CHANGED"); expect(await queue.cachedJobs(other)).toEqual([fresh]);
  });
});

describe("cached field session ownership", () => {
  it("keeps the verified owner when the connection fails while reading a session response", async () => {
    const queue = await setup(), task = job(); await publish(queue, scope, 0, [task], [], "old", stamp);
    const response = Response.json({}); vi.spyOn(response, "json").mockRejectedValue(new TypeError("Connection interrupted"));
    expect(await resolveFieldScope(queue, true, scope, vi.fn().mockResolvedValue(response))).toEqual(scope);
    expect(await queue.cachedJobs(scope)).toEqual([task]);
  });
  it("allows concurrent first activation by the same verified account", async () => {
    const queue = await setup(); await queue.wipe();
    const send = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({ user: { id: scope.userId, organizationId: scope.organizationId, securitySetupRequired: false } })));
    expect(await Promise.all([resolveFieldScope(queue, true, scope, send), resolveFieldScope(queue, true, scope, send)])).toEqual([scope, scope]);
    expect((await queue.metadata.get("identity"))?.value).toBe(fieldIdentity(scope));
  });
  it("checks the current session before showing cached work and removes revoked data", async () => {
    const queue = await setup(), task = job(); await publish(queue, scope, 0, [task], [], "old", stamp);
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ user: { id: scope.userId, organizationId: scope.organizationId, securitySetupRequired: false } }));
    expect(await resolveFieldScope(queue, true, scope, send)).toEqual(scope);
    expect(await resolveFieldScope(queue, false, scope, send)).toEqual(scope); expect(send).toHaveBeenCalledTimes(1);
    expect(await resolveFieldScope(queue, true, scope, vi.fn().mockResolvedValue(Response.json({ user: null })))).toBeNull(); expect(await queue.jobs.count()).toBe(0);
  });
  it("does not let an old response erase a newly signed-in account", async () => {
    const queue = await setup(), other = { organizationId: randomUUID(), userId: randomUUID() }, fresh = job();
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      await queue.activate(other); await publish(queue, other, 0, [fresh], [], "new", stamp);
      return Response.json({ user: { id: scope.userId, organizationId: scope.organizationId, securitySetupRequired: false } });
    });
    await expect(resolveFieldScope(queue, true, scope, send)).rejects.toThrow("FIELD_SESSION_CHANGED");
    expect(await queue.cachedJobs(other)).toEqual([fresh]);
    expect(await resolveFieldScope(queue, false, scope, send)).toBeNull(); expect(await queue.cachedJobs(other)).toEqual([fresh]);
  });
});
