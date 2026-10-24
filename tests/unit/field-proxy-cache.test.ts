import "fake-indexeddb/auto";
import Dexie from "dexie";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldQueue, syncFieldQueue } from "@/platform/offline/field-queue";
import { fieldIdentity, type FieldPhoto, type FieldQueueEntry, type FieldQueueScope } from "@/platform/offline/field-queue-store";
import { refreshFieldCache } from "@/platform/offline/field-pull";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";

const stores: FieldQueue[] = [], scope: FieldQueueScope = { organizationId: randomUUID(), userId: randomUUID() }, stamp = new Date().toISOString();
function job(supervised = false): FieldWorkSnapshot {
  return { id: randomUUID(), propertyId: randomUUID(), propertyName: "Scoped villa", propertyAddress: "Operational address", propertyTimezone: "Africa/Casablanca",
    reservationReference: null, title: { en: "Inspect" }, type: "INSPECTION", state: "ASSIGNED", priority: "NORMAL", dueDate: "2026-10-24", businessDate: "2026-10-24",
    serverVersion: stamp, revision: "A".repeat(43), canEdit: !supervised, checklistItems: [{ id: randomUUID(), key: "ready", label: { en: "Ready" }, completed: false }],
    ...(supervised ? { proxyValidation: { expectedVersion: 1, performedByPersonId: randomUUID() } } : {}) };
}
async function setup(name = `proxy-cache-${randomUUID()}`) { const queue = new FieldQueue(name); stores.push(queue); await queue.activate(scope); return queue; }
async function publish(queue: FieldQueue, task: FieldWorkSnapshot, audience: "assigned" | "supervised") {
  await queue.prepareCache(scope, audience);
  const state = (await queue.readCache(scope, audience)).state!;
  expect(await queue.publishCache(scope, state, [task], [], audience + "-cursor", stamp, audience)).toBe(true);
  return (await queue.readCache(scope, audience)).state!;
}
function draft(task: FieldWorkSnapshot) { return { taskId: task.id, clientOpId: randomUUID(), ...task.proxyValidation!, checklistItemIds: task.checklistItems.map(item => item.id), reason: "Reviewed colleague work retained durably" }; }
function operation(value: ReturnType<typeof draft>) { return { client_op_id: value.clientOpId, type: "field_task.proxy_validate" as const, payload: {
  taskId: value.taskId, expectedVersion: value.expectedVersion, performedByPersonId: value.performedByPersonId, checklistItemIds: value.checklistItemIds, reason: value.reason } }; }
function capture(task: FieldWorkSnapshot) {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
  return { blob: new Blob([bytes], { type: "image/png" }), manifest: { protocolVersion: 1 as const, localId: randomUUID(), taskId: task.id, note: "Own original photo",
    contentType: "image/png" as const, size: bytes.length, sha256, parts: [{ size: bytes.length, sha256 }] } };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.delete())); });

describe("durable supervised field cache", () => {
  it("upgrades populated v3 without changing the device, original queue, draft, cursor or photo bytes", async () => {
    const name = `proxy-upgrade-${randomUUID()}`, legacy = new Dexie(name), task = job(), photo = capture(task), identity = fieldIdentity(scope), deviceId = randomUUID(), incarnation = randomUUID();
    legacy.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
    legacy.version(2).stores({ jobs: "&cacheId,[organizationId+userId]", drafts: "&cacheId,[organizationId+userId]", cacheState: "key" });
    legacy.version(3).stores({ photos: "&cacheId,[organizationId+userId],taskId" });
    const entry: FieldQueueEntry = { ...scope, localId: `${identity}:${photo.manifest.localId}`, sequence: 9, deviceId, syncStatus: "pending", operation: {
      client_op_id: photo.manifest.localId, type: "field_photo.prepare", client_created_at: stamp, payload: { taskId: task.id, photoLocalId: photo.manifest.localId } } };
    const record: FieldPhoto = { ...scope, cacheId: entry.localId, taskId: task.id, manifest: photo.manifest, blob: photo.blob, deviceId, incarnation,
      uploadedParts: [0], uploadId: randomUUID(), ready: false, attempts: 2, retryAt: 123 };
    await legacy.table("metadata").bulkPut([{ key: "identity", value: identity }, { key: "device", value: deviceId }]);
    await legacy.table("operations").add(entry); await legacy.table("jobs").put({ ...scope, cacheId: `${identity}:${task.id}`, task });
    await legacy.table("drafts").put({ ...scope, cacheId: `${identity}:${task.id}`, taskId: task.id, checklistItemIds: [], note: "Original own note", savedAt: stamp });
    await legacy.table("cacheState").put({ ...scope, key: identity, incarnation, generation: 8, cursor: "original-v3-cursor", snapshotAt: stamp });
    await legacy.table("photos").put(record); legacy.close();
    const queue = await setup(name); expect(queue.verno).toBe(4);
    expect((await queue.metadata.get("device"))?.value).toBe(deviceId); expect(await queue.entries(scope)).toEqual([entry]);
    expect((await queue.readCache(scope)).state).toMatchObject({ incarnation, generation: 8, cursor: "original-v3-cursor" });
    expect((await queue.readDraft(scope, task.id))?.note).toBe("Original own note");
    const retained = await queue.photos.get(record.cacheId); expect(retained).toMatchObject({ deviceId, incarnation, uploadId: record.uploadId, uploadedParts: [0], attempts: 2, retryAt: 123 });
    expect(createHash("sha256").update(new Uint8Array(await retained!.blob.arrayBuffer())).digest("hex")).toBe(photo.manifest.sha256);
    expect((await queue.readCache(scope, "supervised")).tasks).toEqual([]);
  });

  it("partitions own and supervised jobs, pull cursors and drafts for the same actor", async () => {
    const queue = await setup(), own = job(), proxy = job(true), value = draft(proxy);
    await publish(queue, own, "assigned"); const state = await publish(queue, proxy, "supervised");
    expect((await queue.readCache(scope)).tasks).toEqual([own]); expect((await queue.readCache(scope)).state?.cursor).toBe("assigned-cursor");
    expect((await queue.readCache(scope, "supervised")).tasks).toEqual([proxy]); expect(state.cursor).toBe("supervised-cursor");
    await queue.saveProxyDraft(scope, value, state.incarnation);
    expect(await queue.readProxyDraft(scope, proxy.id)).toMatchObject(value); expect(await queue.readDraft(scope, proxy.id)).toBeUndefined();
  });

  it("acknowledges proxy work once without erasing own work or resurrecting a completed projection", async () => {
    const queue = await setup(), own = job(), proxy = job(true), value = draft(proxy);
    await publish(queue, own, "assigned"); const state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation); const entry = await queue.enqueue(scope, operation(value));
    const ack = { client_op_id: value.clientOpId, status: "APPLIED" as const, server_version: stamp };
    expect(await queue.acknowledge(scope, entry, ack)).toBe(true); const generation = (await queue.readCache(scope, "supervised")).state!.generation;
    expect(await queue.acknowledge(scope, entry, ack)).toBe(true); expect((await queue.readCache(scope, "supervised")).state!.generation).toBe(generation);
    expect((await queue.readCache(scope, "supervised")).tasks).toEqual([]); expect(await queue.readProxyDraft(scope, proxy.id)).toBeUndefined();
    expect((await queue.readCache(scope)).tasks).toEqual([own]);
    expect(await queue.publishCache(scope, state, [proxy], [], "stale-pull", stamp, "supervised")).toBe(false);
  });

  it("retains the original rejected review and requires an explicit fresh review for a critical change", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy), state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation); const entry = await queue.enqueue(scope, operation(value));
    await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "CONFLICT", server_version: null, error_code: "TASK_PROXY_VALIDATION_CONFLICT" });
    const changed = { ...proxy, proxyValidation: { ...proxy.proxyValidation!, expectedVersion: 2 }, revision: "B".repeat(43) };
    await publish(queue, changed, "supervised"); expect(await queue.readProxyDraft(scope, proxy.id)).toMatchObject(value);
    const reviewed = { ...value, expectedVersion: 2, clientOpId: randomUUID() };
    await expect(queue.saveProxyDraft(scope, reviewed, state.incarnation)).rejects.toThrow("FIELD_PROXY_REVIEW_REQUIRED");
    await queue.reviewProxyDraft(scope, reviewed, value.clientOpId, state.incarnation);
    expect(await queue.readProxyDraft(scope, proxy.id)).toMatchObject(reviewed);
    expect((await queue.entries(scope))[0]).toMatchObject({ operation: operation(value), syncStatus: "conflict" });
  });

  it("invalidates supervised visibility without deleting own pending photos, drafts, cursor or device", async () => {
    const queue = await setup(), own = job(), proxy = job(true), photo = capture(own), ownState = await publish(queue, own, "assigned"), state = await publish(queue, proxy, "supervised");
    await queue.saveDraft(scope, own.id, [], "Own unsent work", ownState.incarnation); await queue.enqueuePhoto(scope, photo.manifest, photo.blob, ownState.incarnation);
    await queue.saveProxyDraft(scope, draft(proxy), state.incarnation); const device = await queue.metadata.get("device");
    await queue.invalidateCache(scope, "supervised");
    expect((await queue.readCache(scope)).tasks).toEqual([own]); expect((await queue.readCache(scope)).state?.cursor).toBe("assigned-cursor");
    expect((await queue.readDraft(scope, own.id))?.note).toBe("Own unsent work"); expect(await queue.photos.count()).toBe(1); expect(await queue.entries(scope)).toHaveLength(1);
    expect(await queue.metadata.get("device")).toEqual(device); expect((await queue.readCache(scope, "supervised")).tasks).toEqual([]);
    expect((await queue.readCache(scope, "supervised")).state?.invalidated).toBe(true); expect(await queue.readProxyDraft(scope, proxy.id)).toBeUndefined();
  });

  it("rejects a stale same-actor acknowledgement after device storage is recreated with reused sequence numbers", async () => {
    const name = `proxy-reset-${randomUUID()}`, old = await setup(name), first = job(true), firstValue = draft(first);
    await publish(old, first, "supervised"); const previous = await old.enqueue(scope, operation(firstValue));
    await old.delete(); stores.splice(stores.indexOf(old), 1);
    const queue = await setup(name), current = job(true), currentValue = draft(current); await publish(queue, current, "supervised");
    const pending = await queue.enqueue(scope, operation(currentValue)); expect(pending.sequence).toBe(previous.sequence);
    expect(await queue.acknowledge(scope, previous, { client_op_id: firstValue.clientOpId, status: "APPLIED", server_version: stamp })).toBe(false);
    expect(await queue.entries(scope)).toEqual([pending]); expect((await queue.readCache(scope, "supervised")).tasks).toEqual([current]);
  });

  it("clears every supervised table on account change and rejects stale-incarnation draft saves", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy), state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation); await queue.wipe(scope); await queue.activate(scope);
    await publish(queue, proxy, "supervised");
    await expect(queue.saveProxyDraft(scope, value, state.incarnation)).rejects.toThrow("FIELD_SESSION_CHANGED");
    const current = (await queue.readCache(scope, "supervised")).state!; await queue.saveProxyDraft(scope, value, current.incarnation);
    const other = { organizationId: randomUUID(), userId: randomUUID() }; await queue.activate(other);
    expect(await queue.proxyJobs.count()).toBe(0); expect(await queue.proxyDrafts.count()).toBe(0);
    await expect(queue.readCache(scope, "supervised")).rejects.toThrow("FIELD_SESSION_CHANGED");
  });

  it("preserves assigned work when supervised pull is forbidden after permission revocation", async () => {
    const queue = await setup(), own = job(), proxy = job(true); await publish(queue, own, "assigned"); await publish(queue, proxy, "supervised");
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(refreshFieldCache(queue, scope, send, { audience: "supervised" })).rejects.toThrow("FIELD_SUPERVISION_REVOKED");
    expect((await queue.readCache(scope)).tasks).toEqual([own]); expect((await queue.readCache(scope, "supervised")).tasks).toEqual([]);
    expect((await queue.metadata.get("identity"))?.value).toBe(fieldIdentity(scope));
  });

  it("retains proxy work when an acknowledgement uses the self-completion duplicate code", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy); await publish(queue, proxy, "supervised"); const entry = await queue.enqueue(scope, operation(value));
    await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "DUPLICATE", server_version: stamp, error_code: "DUPLICATE_COMPLETION" });
    expect(await queue.entries(scope)).toHaveLength(1); expect((await queue.entries(scope))[0].syncStatus).toBe("rejected");
    expect((await queue.readCache(scope, "supervised")).tasks).toEqual([proxy]);
  });

  it("atomically queues the retained reviewed nonce and refuses to rewrite a pending reason", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy), state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation);
    const entry = await queue.enqueueProxy(scope, value, state.incarnation);
    expect(entry.operation).toMatchObject(operation(value)); expect(await queue.enqueueProxy(scope, value, state.incarnation)).toEqual(entry);
    await expect(queue.enqueueProxy(scope, { ...value, reason: "Changed after durable queue submission" }, state.incarnation)).rejects.toThrow("FIELD_PROXY_OPERATION_PENDING");
    expect(await queue.entries(scope)).toEqual([entry]); expect(await queue.readProxyDraft(scope, proxy.id)).toMatchObject(value);
  });

  it("retains failed operation history while a newly reviewed operation resolves its actionable conflict", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy), state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation); const first = await queue.enqueueProxy(scope, value, state.incarnation);
    await queue.acknowledge(scope, first, { client_op_id: value.clientOpId, status: "CONFLICT", server_version: null, error_code: "TASK_PROXY_VALIDATION_CONFLICT" });
    await publish(queue, { ...proxy, proxyValidation: { ...proxy.proxyValidation!, expectedVersion: 2 } }, "supervised");
    const reviewed = { ...value, expectedVersion: 2, clientOpId: randomUUID() }; await queue.reviewProxyDraft(scope, reviewed, value.clientOpId, state.incarnation);
    const second = await queue.enqueueProxy(scope, reviewed, state.incarnation);
    const applied = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ op_schema_version: 1, results: [
      { client_op_id: reviewed.clientOpId, status: "APPLIED", server_version: stamp }
    ] }));
    expect(await syncFieldQueue(queue, scope, applied)).toBe("synced"); expect(applied).toHaveBeenCalledTimes(1);
    await queue.acknowledge(scope, second, { client_op_id: reviewed.clientOpId, status: "APPLIED", server_version: stamp });
    const retained = await queue.entries(scope); expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ operation: operation(value), syncStatus: "conflict", resolvedByClientOpId: reviewed.clientOpId,
      result: { status: "CONFLICT", error_code: "TASK_PROXY_VALIDATION_CONFLICT" } });
    const send = vi.fn<typeof fetch>(); expect(await syncFieldQueue(queue, scope, send)).toBe("idle"); expect(send).not.toHaveBeenCalled();
  });

  it("blocks critical re-review while the original operation is still pending", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy), state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation); const entry = await queue.enqueueProxy(scope, value, state.incarnation);
    await publish(queue, { ...proxy, proxyValidation: { ...proxy.proxyValidation!, expectedVersion: 2 } }, "supervised");
    await expect(queue.reviewProxyDraft(scope, { ...value, expectedVersion: 2, clientOpId: randomUUID() }, value.clientOpId, state.incarnation)).rejects.toThrow("FIELD_PROXY_OPERATION_PENDING");
    expect(await queue.readProxyDraft(scope, proxy.id)).toMatchObject(value); expect(await queue.entries(scope)).toEqual([entry]);
  });

  it("retains the failed ancestor across another review of a replacement that was never queued", async () => {
    const queue = await setup(), proxy = job(true), value = draft(proxy), state = await publish(queue, proxy, "supervised");
    await queue.saveProxyDraft(scope, value, state.incarnation); const first = await queue.enqueueProxy(scope, value, state.incarnation);
    await queue.acknowledge(scope, first, { client_op_id: value.clientOpId, status: "CONFLICT", server_version: null, error_code: "TASK_PROXY_VALIDATION_CONFLICT" });
    const second = { ...value, expectedVersion: 2, clientOpId: randomUUID() };
    await publish(queue, { ...proxy, proxyValidation: { ...proxy.proxyValidation!, expectedVersion: 2 } }, "supervised");
    await queue.reviewProxyDraft(scope, second, value.clientOpId, state.incarnation);
    const third = { ...second, expectedVersion: 3, clientOpId: randomUUID() };
    await publish(queue, { ...proxy, proxyValidation: { ...proxy.proxyValidation!, expectedVersion: 3 } }, "supervised");
    await queue.reviewProxyDraft(scope, third, second.clientOpId, state.incarnation);
    const applied = await queue.enqueueProxy(scope, third, state.incarnation);
    expect(applied.supersedesClientOpId).toBe(value.clientOpId);
    await queue.acknowledge(scope, applied, { client_op_id: third.clientOpId, status: "APPLIED", server_version: stamp });
    expect(await queue.entries(scope)).toEqual([expect.objectContaining({ operation: first.operation, syncStatus: "conflict", resolvedByClientOpId: third.clientOpId })]);
    const send = vi.fn<typeof fetch>(); expect(await syncFieldQueue(queue, scope, send)).toBe("idle"); expect(send).not.toHaveBeenCalled();
  });
});
