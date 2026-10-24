import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldQueue, syncFieldQueue, type FieldQueueScope } from "@/platform/offline/field-queue";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";

const databases: FieldQueue[] = [];
const scope: FieldQueueScope = { organizationId: randomUUID(), userId: randomUUID() };
const operation = () => ({ client_op_id: randomUUID(), type: "field_task.complete" as const,
  client_created_at: new Date().toISOString(), payload: { taskId: randomUUID(), checklistItemIds: [randomUUID()], note: "Work retained" } });
async function setup() {
  const queue = new FieldQueue(`field-test-${randomUUID()}`);
  databases.push(queue);
  await queue.activate(scope);
  return queue;
}
const response = (id: string, status = "APPLIED", extra = {}) => Response.json({ op_schema_version: 1, results: [{ client_op_id: id, status, server_version: "1", ...extra }] });
function input(options?: RequestInit) {
  if (typeof options?.body !== "string") throw new Error("Expected JSON body");
  return syncPushInputSchema.parse(JSON.parse(options.body) as unknown);
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(databases.splice(0).map(queue => queue.delete())); });

describe("durable field operation queue", () => {
  it("retains ordered work across reopening and applies only acknowledged operations", async () => {
    const queue = await setup(), first = operation(), second = operation();
    await Promise.all([queue.enqueue(scope, first), queue.enqueue(scope, first)]);
    await queue.enqueue(scope, second);
    const device = (await queue.entries(scope))[0].deviceId;
    queue.close(); await queue.open();
    const send = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      const body = input(options);
      expect(body).toMatchObject({ actor_user_id: scope.userId, organization_id: scope.organizationId, device_id: device });
      return Promise.resolve(response(body.ops[0].client_op_id));
    });
    expect(await syncFieldQueue(queue, scope, send)).toBe("synced");
    expect(send.mock.calls.map(([, options]) => input(options).ops[0].client_op_id)).toEqual([first.client_op_id, second.client_op_id]);
    expect(await queue.entries(scope)).toEqual([]);
  });

  it("retries the identical operation after a lost acknowledgement and stops behind transient failures", async () => {
    const queue = await setup(), first = operation(); await queue.enqueue(scope, first); await queue.enqueue(scope, operation());
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Network interrupted"));
    expect(await syncFieldQueue(queue, scope, failed)).toBe("queued"); expect(failed).toHaveBeenCalledTimes(1);
    expect((await queue.entries(scope))[0].operation).toEqual(first);
    const retry = vi.fn<typeof fetch>().mockImplementation((_url, options) => Promise.resolve(response(input(options).ops[0].client_op_id, "DUPLICATE")));
    expect(await syncFieldQueue(queue, scope, retry)).toBe("synced"); expect(await queue.entries(scope)).toEqual([]);
  });

  it.each(["CONFLICT", "REJECTED"])("retains %s evidence without automatically resubmitting it", async status => {
    const queue = await setup(), op = operation(); await queue.enqueue(scope, op);
    const send = vi.fn<typeof fetch>().mockResolvedValue(response(op.client_op_id, status, { error_code: "REJECTED_NOT_ASSIGNED" }));
    expect(await syncFieldQueue(queue, scope, send)).toBe(status.toLowerCase());
    await syncFieldQueue(queue, scope, send);
    expect(send).toHaveBeenCalledTimes(1);
    const retained = (await queue.entries(scope))[0].operation;
    expect(retained.type).toBe("field_task.complete");
    if (retained.type !== "field_task.complete") throw new Error("Expected the retained original completion");
    expect(retained.payload.note).toBe("Work retained");
  });

  it.each([Response.json({ op_schema_version: 1, results: [] }), Response.json({ op_schema_version: 1, results: [{ status: "APPLIED" }] }), new Response("bad gateway", { status: 503 })])("keeps work after malformed or unsuccessful acknowledgements", async result => {
    const queue = await setup(); await queue.enqueue(scope, operation());
    expect(await syncFieldQueue(queue, scope, vi.fn().mockResolvedValue(result))).toBe("queued");
    expect(await queue.entries(scope)).toHaveLength(1);
  });

  it("retains work when the server acknowledges an unsupported protocol version", async () => {
    const queue = await setup(), op = operation(); await queue.enqueue(scope, op);
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ op_schema_version: 2, results: [{ client_op_id: op.client_op_id, status: "APPLIED", server_version: "1" }] }));
    expect(await syncFieldQueue(queue, scope, send)).toBe("queued");
    expect(await queue.entries(scope)).toHaveLength(1);
  });

  it("coalesces foreground retries and notifies the active task after its durable acknowledgement", async () => {
    const queue = await setup(), op = operation(); await queue.enqueue(scope, op);
    let release: ((response: Response) => void) | undefined;
    const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    const acknowledged = vi.fn().mockResolvedValue(undefined);
    const first = syncFieldQueue(queue, scope, send, acknowledged), second = syncFieldQueue(queue, scope, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release!(response(op.client_op_id));
    expect(await Promise.all([first, second])).toEqual(["synced", "synced"]);
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith({ ...scope, taskId: op.payload.taskId, clientOpId: op.client_op_id });
    expect(await queue.entries(scope)).toEqual([]);
  });

  it("does not notify an old account when ownership changes before an acknowledgement is stored", async () => {
    const queue = await setup(), op = operation(); await queue.enqueue(scope, op);
    const other = { organizationId: randomUUID(), userId: randomUUID() }, acknowledged = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      await queue.activate(other); await queue.enqueue(other, operation());
      return response(op.client_op_id);
    });
    expect(await syncFieldQueue(queue, scope, send, acknowledged)).toBe("rejected");
    expect(acknowledged).not.toHaveBeenCalled(); expect(await queue.entries(other)).toHaveLength(1);
  });

  it("does not send another user's operations and rejects stale tabs after an account switch", async () => {
    const queue = await setup(); await queue.enqueue(scope, operation());
    const other = { organizationId: randomUUID(), userId: randomUUID() }, send = vi.fn();
    expect(await syncFieldQueue(queue, other, send)).toBe("idle"); expect(send).not.toHaveBeenCalled();
    await queue.activate(other); expect(await queue.entries(scope)).toEqual([]);
    await expect(queue.enqueue(scope, operation())).rejects.toThrow("FIELD_SESSION_CHANGED");
    await queue.enqueue(other, operation());
    // A stale in-flight response cannot erase the new user's queued work.
    await queue.wipe(scope); expect(await queue.entries(other)).toHaveLength(1);
  });

  it("wipes queued records and device identity when the server revokes the session", async () => {
    const queue = await setup(); await queue.enqueue(scope, operation());
    expect(await syncFieldQueue(queue, scope, vi.fn().mockResolvedValue(new Response(null, { status: 401 })))).toBe("rejected");
    expect(await queue.operations.count()).toBe(0); expect(await queue.metadata.count()).toBe(0);
  });

  it("keeps a new account's work when an old tab receives a session-changed response", async () => {
    const queue = await setup(), op = operation(); await queue.enqueue(scope, op);
    const other = { organizationId: randomUUID(), userId: randomUUID() };
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      await queue.activate(other); await queue.enqueue(other, operation());
      return response(op.client_op_id, "REJECTED", { error_code: "REJECTED_SESSION_CHANGED" });
    });
    expect(await syncFieldQueue(queue, scope, send)).toBe("rejected");
    expect(await queue.entries(other)).toHaveLength(1);
  });

  it("does not report success if IndexedDB refuses a write", async () => {
    const queue = await setup(); vi.spyOn(queue.operations, "add").mockRejectedValue(new DOMException("Storage full", "QuotaExceededError"));
    await expect(queue.enqueue(scope, operation())).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await queue.entries(scope)).toEqual([]);
  });

  it("imports the legacy queue durably once, retaining rejected work and original device keys", async () => {
    const queue = await setup(), op = operation();
    const values = new Map([ ["alvillas.fieldTaskQueue.v1", JSON.stringify([{ schemaVersion: 1, userId: scope.userId,
      deviceId: "legacy-device", clientOpId: op.client_op_id, operation: op.type, taskId: op.payload.taskId,
      checklistItemIds: op.payload.checklistItemIds, note: op.payload.note, clientCreatedAt: op.client_created_at, syncStatus: "rejected" }]) ] ]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
    await queue.migrateLegacy(scope, storage); await queue.migrateLegacy(scope, storage);
    expect(await queue.entries(scope)).toMatchObject([{ deviceId: "legacy-device", syncStatus: "rejected", operation: op }]);
    expect(values.size).toBe(0);
  });
});
