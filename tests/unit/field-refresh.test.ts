import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldQueue } from "@/platform/offline/field-queue";
import { refreshFieldCache } from "@/platform/offline/field-pull";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";

const queues: FieldQueue[] = [];
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.delete())); });
describe("explicit cache refresh during an older request", () => {
  it("shares background work but follows an explicit refresh with the latest server changes", async () => {
    const scope = { organizationId: randomUUID(), userId: randomUUID() }, queue = new FieldQueue(`refresh-${randomUUID()}`); queues.push(queue); await queue.activate(scope);
    const task: FieldWorkSnapshot = { id: randomUUID(), propertyId: randomUUID(), propertyName: "Operational villa", propertyAddress: "Test", propertyTimezone: "Africa/Casablanca",
      reservationReference: null, title: { en: "Inspect" }, type: "INSPECTION", state: "ASSIGNED", priority: "NORMAL", dueDate: "2026-10-24", businessDate: "2026-10-24",
      serverVersion: new Date().toISOString(), revision: "A".repeat(43), canEdit: true, checklistItems: [] };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    let requests = 0;
    const send = vi.fn<typeof fetch>(async (): Promise<Response> => {
      requests += 1;
      if (requests === 1) { entered(); await gate; }
      return Response.json({ op_schema_version: 1, organization_id: scope.organizationId, actor_user_id: scope.userId, snapshot_at: new Date().toISOString(),
        cursor: `cursor-${requests}`, next_cursor: null, tasks: [{ ...task, priority: requests === 1 ? "NORMAL" : "HIGH" }], known_changes: [], tombstones: [] });
    });
    const original = refreshFieldCache(queue, scope, send); await started;
    expect(refreshFieldCache(queue, scope, send)).toBe(original);
    const explicit = refreshFieldCache(queue, scope, send, { afterCurrent: true }); release(); await Promise.all([original, explicit]);
    expect(send).toHaveBeenCalledTimes(2); expect((await queue.cachedJobs(scope))[0].priority).toBe("HIGH");
  });
  it("allows the explicit retry to recover after the older request fails", async () => {
    const scope = { organizationId: randomUUID(), userId: randomUUID() }, queue = new FieldQueue(`refresh-${randomUUID()}`); queues.push(queue); await queue.activate(scope);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    let requests = 0;
    const send = vi.fn<typeof fetch>(async (): Promise<Response> => {
      requests += 1;
      if (requests === 1) { entered(); await gate; throw Error("Earlier connection lost"); }
      return Response.json({ op_schema_version: 1, organization_id: scope.organizationId, actor_user_id: scope.userId, snapshot_at: new Date().toISOString(),
        cursor: "recovered", next_cursor: null, tasks: [], known_changes: [], tombstones: [] });
    });
    const original = refreshFieldCache(queue, scope, send); const failed = expect(original).rejects.toThrow("Earlier connection lost"); await started;
    const explicit = refreshFieldCache(queue, scope, send, { afterCurrent: true }); release(); await failed; await explicit;
    expect(send).toHaveBeenCalledTimes(2); expect((await queue.readCache(scope)).state?.cursor).toBe("recovered");
  });
});
