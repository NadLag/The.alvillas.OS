import "fake-indexeddb/auto";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { FieldQueue, syncFieldQueue } from "@/platform/offline/field-queue";
import type { FieldIssueOperation } from "@/platform/offline/field-queue-store";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";

const stores: FieldQueue[] = [], scope = { organizationId: randomUUID(), userId: randomUUID() };
const stamp = new Date().toISOString();
function job(): FieldWorkSnapshot { return { id: randomUUID(), propertyId: randomUUID(), propertyName: "Assigned villa", propertyAddress: "Test",
  propertyTimezone: "Africa/Casablanca", reservationReference: null, title: { en: "Inspect" }, type: "INSPECTION", state: "ASSIGNED", priority: "NORMAL",
  dueDate: "2027-01-01", businessDate: "2027-01-01", serverVersion: stamp, revision: "A".repeat(43), canEdit: true, canReportIssue: true,
  checklistItems: [{ id: randomUUID(), key: "ready", label: { en: "Ready" }, completed: false }] }; }
async function setup() {
  const queue = new FieldQueue(`issues-${randomUUID()}`), task = job(), other = job(); stores.push(queue); await queue.activate(scope);
  const state = await queue.prepareCache(scope); await queue.publishCache(scope, state, [task, other], [], "cursor", stamp);
  const operation: FieldIssueOperation = { type: "field_task.issue.report", client_op_id: randomUUID(), client_created_at: stamp,
    payload: { taskId: task.id, title: "Leaking tap", description: "Water leaking under the sink", severity: "HIGH" } };
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex"), photo = { blob: new Blob([bytes], { type: "image/png" }), manifest: {
    protocolVersion: 1 as const, localId: randomUUID(), taskId: task.id, contentType: "image/png" as const, note: operation.payload.description,
    size: bytes.length, sha256, parts: [{ size: bytes.length, sha256 }] } };
  return { queue, task, other, state, operation, photo, bytes };
}
const result = (id: string, status = "APPLIED") => Response.json({ op_schema_version: 1, results: [{ client_op_id: id, status, server_version: null }] });
function batch(options?: RequestInit) {
  if (typeof options?.body !== "string") throw new Error("Expected queued JSON");
  return syncPushInputSchema.parse(JSON.parse(options.body));
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.delete())); });

describe("field issues share the durable queue and photo transport", () => {
  it("commits the photo before its issue atomically and preserves both wire keys and bytes across reopen", async () => {
    const f = await setup(), op = { ...f.operation, payload: { ...f.operation.payload, photoClientOpId: f.photo.manifest.localId } };
    await f.queue.enqueueIssue(scope, op, f.state.incarnation, f.photo);
    await f.queue.enqueueIssue(scope, op, f.state.incarnation, f.photo);
    const before = await f.queue.entries(scope); expect(before.map(row => row.operation.type)).toEqual(["field_photo.prepare", "field_task.issue.report"]);
    f.queue.close(); await f.queue.open(); expect(await f.queue.entries(scope)).toEqual(before);
    const photos = await f.queue.photos.toArray(); expect(photos).toHaveLength(1);
    expect(Buffer.from(await photos[0].blob.arrayBuffer())).toEqual(f.bytes);
    expect((await f.queue.issueSnapshot(scope, f.task.id)).issues[0].operation).toEqual(op);
    await expect(f.queue.enqueueIssue(scope, { ...op, payload: { ...op.payload, severity: "URGENT" } }, f.state.incarnation, f.photo)).rejects.toThrow("FIELD_ISSUE_KEY_REUSED");
  });
  it("rolls back the photo and operation together on quota failure while retaining the caller's original bytes", async () => {
    const f = await setup(), add = f.queue.operations.add.bind(f.queue.operations);
    vi.spyOn(f.queue.operations, "add").mockImplementation((entry, key) => {
      if (entry.operation.type === "field_task.issue.report") throw new DOMException("Device full", "QuotaExceededError");
      return add(entry, key);
    });
    await expect(f.queue.enqueueIssue(scope, { ...f.operation, payload: { ...f.operation.payload, photoClientOpId: f.photo.manifest.localId } }, f.state.incarnation, f.photo)).rejects.toThrow();
    expect(await f.queue.entries(scope)).toEqual([]); expect(await f.queue.photos.count()).toBe(0);
    expect(Buffer.from(await f.photo.blob.arrayBuffer())).toEqual(f.bytes);
  });
  it("requires the current incarnation and explicit issue permission even when a task remains editable", async () => {
    const f = await setup();
    await expect(f.queue.enqueueIssue(scope, f.operation, randomUUID())).rejects.toThrow("FIELD_SESSION_CHANGED");
    const cached = (await f.queue.jobs.toArray()).find(row => row.task.id === f.task.id)!;
    await f.queue.jobs.put({ ...cached, task: { ...cached.task, canReportIssue: false } });
    await expect(f.queue.enqueueIssue(scope, f.operation, f.state.incarnation)).rejects.toThrow("FIELD_ISSUE_UNAVAILABLE");
    expect(await f.queue.entries(scope)).toEqual([]);
  });
  it("retains a rejected photo and dependent issue, blocks that completion, and synchronizes unrelated work", async () => {
    const f = await setup(); await f.queue.enqueueIssue(scope, { ...f.operation, payload: { ...f.operation.payload, photoClientOpId: f.photo.manifest.localId } }, f.state.incarnation, f.photo);
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [f.task.checklistItems[0].id] } });
    const independent = { ...f.operation, client_op_id: randomUUID(), payload: { ...f.operation.payload, taskId: f.other.id } };
    await f.queue.enqueueIssue(scope, independent, f.state.incarnation);
    const sent: string[] = [], send = vi.fn<typeof fetch>((url, options) => {
      const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (path.includes("/uploads")) return Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 }));
      const body = batch(options); sent.push(body.ops[0].client_op_id); return Promise.resolve(result(body.ops[0].client_op_id));
    });
    expect(await syncFieldQueue(f.queue, scope, send)).toBe("rejected"); await syncFieldQueue(f.queue, scope, send);
    expect(sent).toEqual([independent.client_op_id]); expect(await f.queue.entries(scope)).toHaveLength(3); expect(await f.queue.photos.count()).toBe(1);
  });
  it("retries an unchanged issue after a lost acknowledgement, without completing the job first", async () => {
    const f = await setup(); await f.queue.enqueueIssue(scope, f.operation, f.state.incarnation);
    const completion = { type: "field_task.complete" as const, client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [f.task.checklistItems[0].id] } };
    await f.queue.enqueue(scope, completion);
    expect(await syncFieldQueue(f.queue, scope, vi.fn().mockRejectedValue(new TypeError("Lost acknowledgement")))).toBe("queued");
    const sent: unknown[] = [], send = vi.fn<typeof fetch>((_url, options) => {
      const op = batch(options).ops[0]; sent.push(op); return Promise.resolve(result(op.client_op_id, "DUPLICATE"));
    });
    expect(await syncFieldQueue(f.queue, scope, send)).toBe("synced"); expect(sent).toEqual([f.operation, completion]); expect(await f.queue.entries(scope)).toEqual([]);
  });
  it("rejects mismatched photo provenance and capture after a completion is queued", async () => {
    const f = await setup();
    await expect(f.queue.enqueueIssue(scope, { ...f.operation, payload: { ...f.operation.payload, photoClientOpId: randomUUID() } }, f.state.incarnation, f.photo)).rejects.toThrow("FIELD_ISSUE_PHOTO_INVALID");
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [f.task.checklistItems[0].id] } });
    await expect(f.queue.enqueueIssue(scope, f.operation, f.state.incarnation)).rejects.toThrow("FIELD_ISSUE_UNAVAILABLE");
  });
  it("wipes issue text, linked photos and all existing private tables on account change", async () => {
    const f = await setup(); await f.queue.enqueueIssue(scope, { ...f.operation, payload: { ...f.operation.payload, photoClientOpId: f.photo.manifest.localId } }, f.state.incarnation, f.photo);
    await f.queue.activate({ organizationId: randomUUID(), userId: randomUUID() });
    for (const table of f.queue.tables.filter(table => table.name !== "metadata" && table.name !== "cacheState")) expect(await table.count()).toBe(0);
    expect(await f.queue.entries(scope)).toEqual([]);
  });
});
