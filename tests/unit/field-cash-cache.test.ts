import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { liveQuery } from "dexie";
import { FieldQueue } from "@/platform/offline/field-queue";
import type { FieldCashDraft } from "@/platform/offline/field-queue-store";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { syncFieldQueue } from "@/platform/offline/field-sync";

const scope = { organizationId: randomUUID(), userId: randomUUID() }, stores: FieldQueue[] = [];
const stamp = "2026-10-26T00:30:00.000Z";
async function setup() {
  const queue = new FieldQueue(`cash-${randomUUID()}`); stores.push(queue); await queue.activate(scope);
  const state = await queue.prepareCache(scope);
  const task: FieldWorkSnapshot = { id: randomUUID(), propertyId: randomUUID(), propertyName: "Transfer villa", propertyAddress: "Test",
    propertyTimezone: "Africa/Casablanca", reservationReference: null, title: { en: "Transfer", fr: "Transfert" }, type: "TRANSFER",
    state: "ASSIGNED", priority: "NORMAL", dueDate: "2026-10-26", businessDate: "2026-10-26", serverVersion: stamp,
    revision: "a".repeat(43), canEdit: true, checklistItems: [], cash: { revision: "b".repeat(43), canCollect: true, historyVisible: true,
      baseCurrency: "MAD", currencies: [{ code: "MAD", minorUnit: 2 }], receipts: [] } };
  await queue.publishCache(scope, state, [task], [], "cursor", stamp);
  const draft: FieldCashDraft = { taskId: task.id, amount: "500.25", currency: "MAD", payer: "Fictional guest", purpose: "Transfer collection",
    expectedRevision: task.cash!.revision, clientOpId: randomUUID(), clientCreatedAt: stamp };
  return { queue, state, task, draft };
}
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.delete())); });
describe("cash uses the existing private draft and operation stores", () => {
  it("keeps a cash subscription alive when it starts before local identity binding", async () => {
    const source = await setup(), queue = new FieldQueue(`cash-startup-${randomUUID()}`); stores.push(queue);
    const seen: Array<Awaited<ReturnType<FieldQueue["cashSnapshot"]>>> = [], errors: unknown[] = [];
    const subscription = liveQuery(() => queue.cashSnapshot(scope, source.task.id, "observe")).subscribe({ next: value => { seen.push(value); }, error: (error: unknown) => { errors.push(error); } });
    try {
      await expect.poll(() => seen.length + errors.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(seen.at(-1)?.draft).toBeUndefined(); expect(seen.at(-1)?.task).toBeUndefined();
      await queue.activate(scope); const state = await queue.prepareCache(scope);
      await queue.publishCache(scope, state, [source.task], [], "startup", stamp);
      await expect.poll(() => seen.at(-1)?.task?.cash?.canCollect).toBe(true);
      expect(errors).toEqual([]);
    } finally { subscription.unsubscribe(); }
  });
  it("masks a cash subscription after identity changes without clearing intent or authorizing writes", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const seen: Array<Awaited<ReturnType<FieldQueue["cashSnapshot"]>>> = [], errors: unknown[] = [];
    const subscription = liveQuery(() => f.queue.cashSnapshot(scope, f.task.id, "observe")).subscribe({ next: value => { seen.push(value); }, error: (error: unknown) => { errors.push(error); } });
    try {
      await expect.poll(() => seen.at(-1)?.draft?.clientOpId).toBe(f.draft.clientOpId);
      const count = seen.length;
      await f.queue.metadata.put({ key: "identity", value: `${randomUUID()}:${randomUUID()}` });
      await expect.poll(() => seen.length + errors.length).toBeGreaterThan(count);
      expect(errors).toEqual([]);
      expect(seen.at(-1)?.task).toBeUndefined(); expect(seen.at(-1)?.draft).toBeUndefined(); expect(seen.at(-1)?.entries).toEqual([]);
      expect((await f.queue.drafts.toArray())[0].cash).toEqual(f.draft);
      await expect(f.queue.saveCashDraft(scope, f.draft, f.state.incarnation)).rejects.toThrow("FIELD_SESSION_CHANGED");
    } finally { subscription.unsubscribe(); }
  });
  it("queues cash behind nonterminal task evidence without blocking the financial draft", async () => {
    const f = await setup();
    await f.queue.enqueue(scope, { type: "field_task.evidence.attach", client_op_id: randomUUID(), payload: { taskId: f.task.id, uploadId: randomUUID() } });
    expect(await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation)).toBe(true);
    await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    expect((await f.queue.entries(scope)).map(entry => entry.operation.type)).toEqual(["field_task.evidence.attach", "field_cash.collect"]);
  });
  it("blocks new financial intents after task completion is queued", async () => {
    const f = await setup();
    await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [randomUUID()] } });
    expect(await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation)).toBe(false);
    await expect(f.queue.enqueueCash(scope, f.draft, f.state.incarnation)).rejects.toThrow("FIELD_CASH_PENDING");
  });
  it("allows only the original failed receipt to be confirmed behind a completion", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const original = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [randomUUID()] } });
    await f.queue.acknowledge(scope, original, { client_op_id: f.draft.clientOpId, status: "CONFLICT", server_version: "c".repeat(43) });
    const confirm = { taskId: f.task.id, originalDeviceId: original.deviceId, originalClientOpId: f.draft.clientOpId, receiptId: randomUUID(), reason: "Reviewed original cash receipt" };
    await expect(f.queue.confirmCash(scope, confirm, f.state.incarnation, randomUUID())).rejects.toThrow("FIELD_CASH_REVIEW_REQUIRED");
    await expect(f.queue.confirmCash(scope, { ...confirm, originalClientOpId: randomUUID() }, f.state.incarnation, f.draft.clientOpId)).rejects.toThrow("FIELD_CASH_REVIEW_REQUIRED");
    const reviewed = await f.queue.confirmCash(scope, confirm, f.state.incarnation, f.draft.clientOpId);
    await f.queue.acknowledge(scope, reviewed, { client_op_id: reviewed.operation.client_op_id, status: "APPLIED", server_version: "c".repeat(43) });
    expect((await f.queue.entries(scope)).find(entry => entry.sequence === original.sequence)).toMatchObject({ syncStatus: "conflict", resolvedByClientOpId: reviewed.operation.client_op_id });
    expect((await f.queue.cashSnapshot(scope, f.task.id)).completionPending).toBe(true);
  });
  it("restores an already submitted immutable cash nonce ahead of a queued completion", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const original = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [randomUUID()] } });
    await f.queue.operations.delete(original.sequence!); await f.queue.restoreSubmittedCash(scope);
    expect((await f.queue.entries(scope)).find(entry => entry.operation.type === "field_cash.collect")).toMatchObject({ deviceId: original.deviceId, operation: original.operation });
  });
  it("recovers a failed cash receipt while its dependent completion remains queued", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const original = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [randomUUID()] } });
    await f.queue.acknowledge(scope, original, { client_op_id: f.draft.clientOpId, status: "CONFLICT", server_version: "c".repeat(43) });
    await f.queue.publishCache(scope, (await f.queue.readCache(scope)).state!, [{ ...f.task, cash: { ...f.task.cash!, revision: "c".repeat(43) } }], [], "fresh", stamp);
    const reviewed = { ...f.draft, amount: "25", clientOpId: randomUUID(), expectedRevision: "c".repeat(43), supersedesClientOpId: f.draft.clientOpId };
    expect(await f.queue.saveCashDraft(scope, reviewed, f.state.incarnation)).toBe(true);
    await f.queue.enqueueCash(scope, reviewed, f.state.incarnation);
    const requests: string[] = [];
    const send = (_url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a serialized operation");
      const body = JSON.parse(init.body) as { ops: Array<{ type: string; client_op_id: string }> }; requests.push(body.ops[0].type);
      return Promise.resolve(Response.json({ op_schema_version: 1, results: [{ client_op_id: body.ops[0].client_op_id, status: "APPLIED", server_version: body.ops[0].type === "field_cash.collect" ? "d".repeat(43) : stamp }] }));
    };
    await syncFieldQueue(f.queue, scope, send); await syncFieldQueue(f.queue, scope, send);
    expect(requests).toEqual(["field_cash.collect", "field_task.complete"]);
    expect(await f.queue.entries(scope)).toEqual([expect.objectContaining({ operation: original.operation, syncStatus: "conflict", resolvedByClientOpId: reviewed.clientOpId })]);
  });
  it("preserves cash, checklist and exact nonce across edits and cold reopen without adding a store", async () => {
    const f = await setup(); await f.queue.saveDraft(scope, f.task.id, [], "Existing note", f.state.incarnation);
    expect(await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation)).toBe(true);
    await f.queue.saveDraft(scope, f.task.id, [], "Revised note", f.state.incarnation);
    f.queue.close(); await f.queue.open();
    expect((await f.queue.cashSnapshot(scope, f.task.id)).draft).toEqual(f.draft);
    expect((await f.queue.drafts.toArray())[0].note).toBe("Revised note"); expect(f.queue.tables).toHaveLength(9); expect(f.queue.verno).toBe(5);
  });
  it("keeps one immutable submitted operation and recovers its exact nonce after an older worker acknowledgment", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const entry = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    expect((await f.queue.enqueueCash(scope, f.draft, f.state.incarnation)).sequence).toBe(entry.sequence);
    await expect(f.queue.enqueueCash(scope, { ...f.draft, amount: "600" }, f.state.incarnation)).rejects.toThrow("FIELD_CASH_KEY_REUSED");
    expect(await f.queue.saveCashDraft(scope, { ...f.draft, amount: "600" }, f.state.incarnation)).toBe(false);
    expect(await f.queue.clearCashDraft(scope, f.task.id, f.draft.clientOpId)).toBe(false);
    await f.queue.operations.delete(entry.sequence!);
    await expect(f.queue.enqueueCash(scope, { ...f.draft, amount: "600" }, f.state.incarnation)).rejects.toThrow("FIELD_CASH_KEY_REUSED");
    await f.queue.restoreSubmittedCash(scope);
    const restored = (await f.queue.entries(scope))[0];
    expect(restored.deviceId).toBe(entry.deviceId); expect(restored.operation).toEqual(entry.operation);
    await f.queue.acknowledge(scope, restored, { client_op_id: f.draft.clientOpId, status: "DUPLICATE", server_version: "c".repeat(43) });
    expect((await f.queue.cashSnapshot(scope, f.task.id)).draft).toBeUndefined(); expect(await f.queue.entries(scope)).toHaveLength(0);
  });
  it("retains failed receipts through explicit additional-cash review and resolves them only after the new receipt succeeds", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const original = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    await f.queue.acknowledge(scope, original, { client_op_id: f.draft.clientOpId, status: "CONFLICT", server_version: "c".repeat(43), error_code: "CASH_COLLECTION_CONFLICT" });
    await f.queue.publishCache(scope, (await f.queue.readCache(scope)).state!, [{ ...f.task, cash: { ...f.task.cash!, revision: "c".repeat(43) } }], [], "fresh", stamp);
    const reviewed = { ...f.draft, amount: "25", clientOpId: randomUUID(), expectedRevision: "c".repeat(43), supersedesClientOpId: f.draft.clientOpId };
    expect(await f.queue.saveCashDraft(scope, reviewed, f.state.incarnation)).toBe(true);
    const next = await f.queue.enqueueCash(scope, reviewed, f.state.incarnation);
    expect((await f.queue.entries(scope)).find(entry => entry.sequence === original.sequence)?.resolvedByClientOpId).toBeUndefined();
    await f.queue.acknowledge(scope, next, { client_op_id: reviewed.clientOpId, status: "APPLIED", server_version: "d".repeat(43) });
    expect((await f.queue.entries(scope))[0]).toMatchObject({ syncStatus: "conflict", resolvedByClientOpId: reviewed.clientOpId, operation: original.operation });
  });
  it("rejects malformed acknowledgments and preserves financial drafts when a task is removed", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const entry = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    expect(await f.queue.acknowledge(scope, entry, { client_op_id: f.draft.clientOpId, status: "APPLIED", server_version: "1" })).toBe(false);
    await f.queue.publishCache(scope, (await f.queue.readCache(scope)).state!, [], [f.task.id], "removed", stamp);
    expect((await f.queue.cashSnapshot(scope, f.task.id)).draft?.clientOpId).toBe(f.draft.clientOpId);
    expect(await f.queue.entries(scope)).toHaveLength(1);
  });
  it("fences another incarnation and clears all private cash on account change", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    await expect(f.queue.enqueueCash(scope, f.draft, randomUUID())).rejects.toThrow("FIELD_SESSION_CHANGED");
    await f.queue.activate({ organizationId: scope.organizationId, userId: randomUUID() });
    await expect(f.queue.cashSnapshot(scope, f.task.id)).rejects.toThrow("FIELD_SESSION_CHANGED");
    expect(JSON.stringify(await f.queue.drafts.toArray())).not.toContain(f.draft.payer);
    await f.queue.wipe(); for (const table of f.queue.tables) expect(await table.count()).toBe(0);
  });
  it("retains a queued completion behind a failed cash receipt without submitting the completion", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation);
    const cash = await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    await f.queue.acknowledge(scope, cash, { client_op_id: f.draft.clientOpId, status: "CONFLICT", server_version: "c".repeat(43) });
    const complete = await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [randomUUID()] } });
    let requests = 0;
    expect(await syncFieldQueue(f.queue, scope, () => { requests++; return Promise.reject(new Error("Completion must stay queued")); })).toBe("conflict");
    expect(requests).toBe(0); expect((await f.queue.entries(scope)).find(entry => entry.sequence === complete.sequence)?.syncStatus).toBe("pending");
  });
  it("synchronizes cash before an offline completion and preserves the committed receipt nonce", async () => {
    const f = await setup(); await f.queue.saveCashDraft(scope, f.draft, f.state.incarnation); await f.queue.enqueueCash(scope, f.draft, f.state.incarnation);
    await f.queue.enqueue(scope, { type: "field_task.complete", client_op_id: randomUUID(), payload: { taskId: f.task.id, checklistItemIds: [randomUUID()] } });
    const requests: string[] = [];
    const result = await syncFieldQueue(f.queue, scope, (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a serialized operation");
      const body = JSON.parse(init.body) as { ops: Array<{ type: string; client_op_id: string }> }; requests.push(body.ops[0].type);
      return Promise.resolve(Response.json({ op_schema_version: 1, results: [{ client_op_id: body.ops[0].client_op_id, status: "APPLIED", server_version: body.ops[0].type === "field_cash.collect" ? "c".repeat(43) : stamp }] }));
    });
    expect(result).toBe("synced"); expect(requests).toEqual(["field_cash.collect", "field_task.complete"]); expect(await f.queue.entries(scope)).toHaveLength(0);
    expect((await f.queue.cashSnapshot(scope, f.task.id)).draft).toBeUndefined();
  });
});
