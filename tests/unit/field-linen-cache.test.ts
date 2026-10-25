import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { FieldQueue } from "@/platform/offline/field-queue";
import { fieldIdentity, type FieldLinenDraftInput } from "@/platform/offline/field-queue-store";
import { syncFieldQueue } from "@/platform/offline/field-sync";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";

const scope = { organizationId: randomUUID(), userId: randomUUID() }, stamp = "2026-10-25T12:00:00.000Z";
const stores: FieldQueue[] = [];
function job(): FieldWorkSnapshot {
  return { id: randomUUID(), propertyId: randomUUID(), propertyName: "Linen villa", propertyAddress: "Test", propertyTimezone: "Africa/Casablanca",
    reservationReference: null, title: { en: "Observe linen", fr: "Compter le linge" }, type: "INSPECTION", state: "ASSIGNED", priority: "NORMAL",
    dueDate: "2026-10-25", businessDate: "2026-10-25", serverVersion: stamp, revision: "a".repeat(43), canEdit: true,
    checklistItems: [{ id: randomUUID(), key: "ready", label: { en: "Ready", fr: "Prêt" }, completed: false }], linen: {
      catalog: { id: randomUUID(), version: 1 }, items: [{ key: "bath_towel", name: { en: "Bath towel", fr: "Serviette" }, unit: "pieces", quantity: "12", revision: "3", available: true }] } };
}
function draft(task: FieldWorkSnapshot): FieldLinenDraftInput {
  return { taskId: task.id, itemKey: "bath_towel", expectedQuantity: task.linen!.items[0].quantity, expectedRevision: task.linen!.items[0].revision,
    countedQuantity: "10", unit: "pieces", catalogRuleId: task.linen!.catalog!.id, catalogVersion: 1, note: "Physical linen count", clientOpId: randomUUID() };
}
async function setup() {
  const queue = new FieldQueue(`field-linen-${randomUUID()}`); stores.push(queue); await queue.activate(scope);
  const task = job(), state = await queue.prepareCache(scope);
  await queue.publishCache(scope, state, [task], [], "cursor-one", stamp);
  return { queue, task, value: draft(task), incarnation: state.incarnation };
}
async function advance(queue: FieldQueue, task: FieldWorkSnapshot, quantity = "11", revision = "4") {
  const fresh = { ...task, linen: { ...task.linen!, items: task.linen!.items.map(item => ({ ...item, quantity, revision })) } };
  await queue.publishCache(scope, await queue.prepareCache(scope), [fresh], [], "cursor-two", stamp); return fresh;
}
describe("durable field linen drafts and reviewed stocktake queue", () => {
  afterEach(async () => { await Promise.all(stores.splice(0).map(queue => queue.delete())); });
  it("restores exact quantities, original nonce, note and scope after a cold database reopen", async () => {
    const { queue, task, value, incarnation } = await setup(); value.countedQuantity = "9007199254740993";
    await queue.saveLinenDraft(scope, value, incarnation); const device = (await queue.metadata.get("device"))!.value;
    queue.close(); await queue.open();
    expect((await queue.linenSnapshot(scope, task.id, value.itemKey)).draft).toMatchObject({ ...scope, ...value });
    expect((await queue.metadata.get("device"))?.value).toBe(device); expect(queue.verno).toBe(5);
  });
  it("upgrades an existing v4 device while preserving its actor, device, assigned and supervised cache, queue and drafts", async () => {
    const name = `field-linen-upgrade-${randomUUID()}`, legacy = new Dexie(name), task = job(), identity = fieldIdentity(scope), deviceId = randomUUID();
    legacy.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
    legacy.version(2).stores({ jobs: "&cacheId,[organizationId+userId]", drafts: "&cacheId,[organizationId+userId]", cacheState: "key" });
    legacy.version(3).stores({ photos: "&cacheId,[organizationId+userId],taskId" });
    legacy.version(4).stores({ proxyJobs: "&cacheId,[organizationId+userId]", proxyDrafts: "&cacheId,[organizationId+userId]" });
    const cached = { ...scope, cacheId: `${identity}:${task.id}`, task }, state = { ...scope, key: identity, incarnation: randomUUID(), generation: 7, cursor: "original-v4-cursor", snapshotAt: stamp };
    const saved = { ...scope, cacheId: cached.cacheId, taskId: task.id, checklistItemIds: [], note: "Original assigned draft", savedAt: stamp };
    const proxy = { ...scope, cacheId: cached.cacheId, taskId: task.id, clientOpId: randomUUID(), expectedVersion: 2,
      performedByPersonId: randomUUID(), checklistItemIds: [], reason: "Original supervisor review", savedAt: stamp };
    const pending = { ...scope, localId: `${identity}:${randomUUID()}`, deviceId, sequence: 9, syncStatus: "pending", operation: {
      type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: task.id, checklistItemIds: [task.checklistItems[0].id] } } };
    pending.localId = `${identity}:${pending.operation.client_op_id}`;
    try {
      await legacy.table("metadata").bulkPut([{ key: "identity", value: identity }, { key: "device", value: deviceId }]);
      await legacy.table("jobs").put(cached); await legacy.table("proxyJobs").put(cached);
      await legacy.table("drafts").put(saved); await legacy.table("proxyDrafts").put(proxy);
      await legacy.table("cacheState").put(state); await legacy.table("operations").put(pending);
    } finally { legacy.close(); }
    const queue = new FieldQueue(name); stores.push(queue); await queue.activate(scope);
    expect(queue.verno).toBe(5); expect(await queue.metadata.get("device")).toEqual({ key: "device", value: deviceId });
    expect(await queue.cachedJobs(scope)).toEqual([task]); expect(await queue.cachedJobs(scope, "supervised")).toEqual([task]);
    expect((await queue.readCache(scope)).state).toEqual(state); expect(await queue.entries(scope)).toEqual([pending]);
    expect(await queue.readDraft(scope, task.id)).toEqual(saved); expect(await queue.readProxyDraft(scope, task.id)).toEqual(proxy);
    expect(await queue.linenDrafts.count()).toBe(0);
  });
  it("keeps incomplete typed counts and notes locally while preventing an invalid operation", async () => {
    const { queue, task, value, incarnation } = await setup(); value.countedQuantity = ""; value.note = "";
    await queue.saveLinenDraft(scope, value, incarnation);
    expect((await queue.linenSnapshot(scope, task.id, value.itemKey)).draft).toMatchObject(value);
    await expect(queue.enqueueLinen(scope, value, incarnation)).rejects.toThrow(); expect(await queue.entries(scope)).toEqual([]);
  });
  it("enqueues a restored draft once and freezes its original payload while pending", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation);
    const restored = (await queue.linenSnapshot(scope, task.id, value.itemKey)).draft!;
    const one = await queue.enqueueLinen(scope, restored, incarnation), two = await queue.enqueueLinen(scope, restored, incarnation);
    expect(two).toEqual(one); expect(await queue.entries(scope)).toHaveLength(1);
    await expect(queue.saveLinenDraft(scope, { ...value, countedQuantity: "9" }, incarnation)).rejects.toThrow("FIELD_LINEN_OPERATION_PENDING");
    await expect(queue.saveLinenDraft(scope, { ...value, clientOpId: randomUUID() }, incarnation, value.clientOpId)).rejects.toThrow("FIELD_LINEN_OPERATION_PENDING");
    expect((await queue.entries(scope))[0].operation.payload).toMatchObject({ countedQuantity: "10", expectedQuantity: "12" });
  });
  it("requires explicit review when a newer stock position replaces a saved unqueued draft", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation); const fresh = await advance(queue, task);
    await expect(queue.enqueueLinen(scope, value, incarnation)).rejects.toThrow("FIELD_LINEN_REVIEW_REQUIRED");
    const reviewed = { ...draft(fresh), countedQuantity: value.countedQuantity, note: value.note };
    await expect(queue.saveLinenDraft(scope, reviewed, incarnation)).rejects.toThrow("FIELD_LINEN_REVIEW_REQUIRED");
    expect(await queue.saveLinenDraft(scope, reviewed, incarnation, value.clientOpId)).toBe(true);
    expect((await queue.enqueueLinen(scope, reviewed, incarnation)).operation.payload).toMatchObject({ expectedQuantity: "11", expectedRevision: "4", countedQuantity: "10" });
  });
  it("preserves the original conflict through multiple unqueued reviews and resolves its history only after a new acknowledged count", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation);
    const original = await queue.enqueueLinen(scope, value, incarnation), result = { client_op_id: value.clientOpId, status: "CONFLICT" as const, server_version: "4",
      error_code: "STOCKTAKE_CONFLICT", stocktake: { expected: { quantity: "12", revision: "3" }, current: { quantity: "11", revision: "4" } } };
    await queue.acknowledge(scope, original, result); const fresh = await advance(queue, task);
    const first = draft(fresh); await queue.saveLinenDraft(scope, first, incarnation, value.clientOpId);
    const second = { ...first, clientOpId: randomUUID() }; await queue.saveLinenDraft(scope, second, incarnation, first.clientOpId);
    const reviewed = await queue.enqueueLinen(scope, second, incarnation); expect(reviewed.supersedesClientOpId).toBe(value.clientOpId);
    expect((await queue.entries(scope))[0].resolvedByClientOpId).toBeUndefined();
    await queue.acknowledge(scope, reviewed, { client_op_id: second.clientOpId, status: "APPLIED", server_version: "5" });
    const history = await queue.entries(scope); expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ operation: original.operation, result, resolvedByClientOpId: second.clientOpId, syncStatus: "conflict" });
    expect((await queue.linenSnapshot(scope, task.id, value.itemKey)).draft).toBeUndefined();
  });
  it("publishes the authoritative conflict position atomically before a delayed pull permits immediate review", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation);
    const original = await queue.enqueueLinen(scope, value, incarnation), before = (await queue.readCache(scope)).state!;
    const result = { client_op_id: value.clientOpId, status: "CONFLICT" as const, server_version: "4", error_code: "STOCKTAKE_CONFLICT",
      stocktake: { expected: { quantity: "12", revision: "3" }, current: { quantity: "11", revision: "4" } } };
    expect(await queue.acknowledge(scope, original, result)).toBe(true);
    const snapshot = await queue.linenSnapshot(scope, task.id, value.itemKey);
    expect(snapshot.task!.linen!.items[0]).toMatchObject({ quantity: "11", revision: "4" });
    expect(snapshot.state!.generation).toBe(before.generation + 1);
    expect(snapshot.draft).toMatchObject(value); expect(snapshot.entries[0]).toMatchObject({ operation: original.operation, syncStatus: "conflict", result });
    const reviewed = { ...draft(snapshot.task!), countedQuantity: "" }; expect(await queue.saveLinenDraft(scope, reviewed, incarnation, value.clientOpId)).toBe(true);
    expect((await queue.linenSnapshot(scope, task.id, value.itemKey)).draft).toMatchObject({ expectedQuantity: "11", expectedRevision: "4", countedQuantity: "" });
  });
  it.each([
    { expected: { quantity: "13", revision: "3" }, current: { quantity: "11", revision: "4" }, server: "4" },
    { expected: { quantity: "12", revision: "2" }, current: { quantity: "11", revision: "4" }, server: "4" },
    { expected: { quantity: "12", revision: "3" }, current: { quantity: "11", revision: "4" }, server: "5" },
    { expected: { quantity: "12", revision: "3" }, current: { quantity: "11", revision: "3" }, server: "3" },
    { expected: { quantity: "12", revision: "3" }, current: { quantity: "1.5", revision: "4" }, server: "4" },
    { expected: { quantity: "12", revision: "3" }, current: { quantity: "11", revision: "-1" }, server: "-1" }
  ])("retains the original stock and draft when a conflict snapshot fails provenance or canonical validation %#", async position => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation);
    const original = await queue.enqueueLinen(scope, value, incarnation), before = (await queue.readCache(scope)).state!;
    await queue.acknowledge(scope, original, { client_op_id: value.clientOpId, status: "CONFLICT", server_version: position.server,
      error_code: "STOCKTAKE_CONFLICT", stocktake: { expected: position.expected, current: position.current } });
    const snapshot = await queue.linenSnapshot(scope, task.id, value.itemKey);
    expect(snapshot.task!.linen!.items[0]).toMatchObject({ quantity: "12", revision: "3" });
    expect(snapshot.state).toEqual(before); expect(snapshot.draft).toMatchObject(value); expect(snapshot.entries[0].operation).toEqual(original.operation);
  });
  it("never overwrites a newer pulled position or its reviewed draft with a delayed conflict receipt", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation);
    const original = await queue.enqueueLinen(scope, value, incarnation), result = { client_op_id: value.clientOpId, status: "CONFLICT" as const,
      server_version: "4", error_code: "STOCKTAKE_CONFLICT", stocktake: { expected: { quantity: "12", revision: "3" }, current: { quantity: "11", revision: "4" } } };
    await queue.acknowledge(scope, original, result); const fresh = await advance(queue, task, "8", "5"), reviewed = draft(fresh);
    await queue.saveLinenDraft(scope, reviewed, incarnation, value.clientOpId); const before = await queue.linenSnapshot(scope, task.id, value.itemKey);
    await queue.acknowledge(scope, original, result); const after = await queue.linenSnapshot(scope, task.id, value.itemKey);
    expect(after.task).toEqual(before.task); expect(after.draft).toEqual(before.draft); expect(after.state).toEqual(before.state);
  });
  it("retains a queued count across lost acknowledgements and applies the original-key duplicate to its exact cached base", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation); await queue.enqueueLinen(scope, value, incarnation);
    const sent: string[] = []; let delivered = false;
    const send: typeof fetch = async (_url, options) => {
      await Promise.resolve();
      if (typeof options?.body !== "string") throw new Error("Expected a JSON synchronization body");
      const input = syncPushInputSchema.parse(JSON.parse(options.body)); sent.push(input.ops[0].client_op_id);
      if (!delivered) { delivered = true; throw new Error("Acknowledgement lost after server commit"); }
      return Response.json({ op_schema_version: 1, results: [{ client_op_id: value.clientOpId, status: "DUPLICATE", server_version: "4" }] });
    };
    expect(await syncFieldQueue(queue, scope, send)).toBe("queued"); expect(await queue.entries(scope)).toHaveLength(1);
    expect(await syncFieldQueue(queue, scope, send)).toBe("synced"); expect(sent).toEqual([value.clientOpId, value.clientOpId]);
    expect((await queue.cachedJobs(scope))[0].linen?.items[0]).toMatchObject({ quantity: "10", revision: "4" });
    expect((await queue.cachedJobs(scope))[0].id).toBe(task.id); expect(await queue.entries(scope)).toEqual([]);
  });
  it("refuses a malformed stock acknowledgement and never overwrites a newer pulled position or a later unsent draft", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation); const entry = await queue.enqueueLinen(scope, value, incarnation);
    expect(await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "APPLIED", server_version: null })).toBe(false);
    const fresh = await advance(queue, task, "8", "5");
    expect(await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "DUPLICATE", server_version: "4" })).toBe(true);
    const next = draft(fresh); await queue.saveLinenDraft(scope, next, incarnation);
    await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "DUPLICATE", server_version: "4" });
    expect((await queue.linenSnapshot(scope, task.id, value.itemKey)).draft?.clientOpId).toBe(next.clientOpId);
    expect((await queue.cachedJobs(scope))[0].linen?.items[0]).toMatchObject({ quantity: "8", revision: "5" });
  });
  it("does not complete a task with an unresolved stock conflict and still synchronizes another job", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation); const entry = await queue.enqueueLinen(scope, value, incarnation);
    await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "CONFLICT", server_version: "4", error_code: "STOCKTAKE_CONFLICT" });
    const completion = await queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: task.id, checklistItemIds: [task.checklistItems[0].id] } });
    const other = await queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: randomUUID(), checklistItemIds: [randomUUID()] } });
    const sent: string[] = [];
    expect(await syncFieldQueue(queue, scope, async (_url, options) => {
      await Promise.resolve();
      if (typeof options?.body !== "string") throw new Error("Expected a JSON synchronization body");
      const input = syncPushInputSchema.parse(JSON.parse(options.body)); sent.push(input.ops[0].client_op_id);
      return Response.json({ op_schema_version: 1, results: [{ client_op_id: input.ops[0].client_op_id, status: "APPLIED", server_version: stamp }] });
    })).toBe("conflict");
    expect(sent).toEqual([other.operation.client_op_id]); expect((await queue.entries(scope)).some(entry => entry.localId === completion.localId)).toBe(true);
  });
  it("wipes linen drafts with every private table on logout or account change and fences an old acknowledgement", async () => {
    const { queue, task, value, incarnation } = await setup(); await queue.saveLinenDraft(scope, value, incarnation); const entry = await queue.enqueueLinen(scope, value, incarnation);
    expect(await queue.linenDrafts.count()).toBe(1); await queue.wipe(scope);
    expect(queue.tables).toHaveLength(9); for (const table of queue.tables) expect(await table.count()).toBe(0);
    await queue.activate(scope); const state = await queue.prepareCache(scope); await queue.publishCache(scope, state, [task], [], "cursor", stamp);
    await queue.saveLinenDraft(scope, { ...value, clientOpId: randomUUID() }, state.incarnation);
    const other = { ...scope, userId: randomUUID() }; await queue.activate(other); expect(await queue.linenDrafts.count()).toBe(0);
    expect((await queue.metadata.get("identity"))?.value).toBe(fieldIdentity(other));
    expect(await queue.acknowledge(scope, entry, { client_op_id: value.clientOpId, status: "APPLIED", server_version: "4" })).toBe(false);
  });
});
