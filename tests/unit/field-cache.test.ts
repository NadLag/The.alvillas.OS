import "fake-indexeddb/auto";
import Dexie from "dexie";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldQueue } from "@/platform/offline/field-queue";
import { fieldIdentity, type FieldQueueScope } from "@/platform/offline/field-queue-store";
import { refreshFieldCache } from "@/platform/offline/field-pull";
import { resolveFieldScope } from "@/platform/offline/field-session";
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
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.delete())); });
describe("field work cache", () => {
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
