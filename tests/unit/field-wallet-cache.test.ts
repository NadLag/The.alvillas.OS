import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FieldQueue } from "@/platform/offline/field-queue";
import type { FieldWalletSnapshot } from "@/modules/identity/domain/field-wallet";

const stores: FieldQueue[] = [], owner = { organizationId: randomUUID(), userId: randomUUID() };
async function setup() {
  const queue = new FieldQueue(`wallet-${randomUUID()}`); stores.push(queue); await queue.activate(owner);
  const state = await queue.prepareCache(owner), snapshot: FieldWalletSnapshot = { ...owner, page: 1, snapshotAt: new Date().toISOString(), linked: true,
    baseCurrency: "MAD", balances: [{ amount: "450.00", currency: "MAD" }, { amount: "75.25", currency: "EUR" }],
    movements: [{ id: randomUUID(), reference: "Own advance", description: "Staff advance", occurredAt: new Date().toISOString(), amount: "450", currency: "MAD", side: "DEBIT", bucket: "ADVANCE" }],
    hasNext: false, compensationVisible: false, compensationTerms: [] };
  const readId = await queue.beginWalletRead(owner, state.incarnation);
  return { queue, state, snapshot, readId };
}
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.delete())); });
describe("wallet cache reuses existing account-scoped private state", () => {
  it("retains exact own-currency figures across reopening and ordinary work pulls", async () => {
    const f = await setup(); expect(await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId)).toBe(true);
    f.queue.close(); await f.queue.open(); expect((await f.queue.walletSnapshot(owner)).wallet).toEqual(f.snapshot);
    const pending = await f.queue.beginWalletRead(owner, f.state.incarnation);
    await f.queue.publishCache(owner, (await f.queue.readCache(owner)).state!, [], [], "fresh-work", new Date().toISOString());
    expect((await f.queue.walletSnapshot(owner)).wallet).toEqual(f.snapshot); expect(f.queue.tables).toHaveLength(9);
    expect(await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, pending)).toBe(true);
  });
  it("rejects another account, organization and an expired incarnation without overwriting the saved snapshot", async () => {
    const f = await setup(); await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId);
    for (const wallet of [{ ...f.snapshot, userId: randomUUID() }, { ...f.snapshot, organizationId: randomUUID() }])
      expect(await f.queue.saveWalletSnapshot(owner, wallet, f.state.incarnation, await f.queue.beginWalletRead(owner, f.state.incarnation))).toBe(false);
    expect(await f.queue.saveWalletSnapshot(owner, f.snapshot, randomUUID(), f.readId)).toBe(false);
    expect((await f.queue.walletSnapshot(owner)).wallet).toEqual(f.snapshot);
  });
  it("removes all wallet data on account change and prevents a late old request from restoring it", async () => {
    const f = await setup(); await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId);
    const oldRequest = await f.queue.beginWalletRead(owner, f.state.incarnation);
    const next = { organizationId: owner.organizationId, userId: randomUUID() }; await f.queue.activate(next);
    expect((await f.queue.walletSnapshot(next)).wallet).toBeNull(); expect(await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, oldRequest)).toBe(false);
    expect(JSON.stringify(await f.queue.cacheState.toArray())).not.toContain("450.00");
    await expect(f.queue.walletSnapshot(owner)).rejects.toThrow("FIELD_SESSION_CHANGED");
  });
  it("clears a revoked wallet grant without deleting unrelated pending work", async () => {
    const f = await setup(); await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId);
    const operation = { type: "field_task.complete" as const, client_op_id: randomUUID(), payload: { taskId: randomUUID(), checklistItemIds: [randomUUID()] } };
    await f.queue.enqueue(owner, operation); expect(await f.queue.saveWalletSnapshot(owner, null, f.state.incarnation, await f.queue.beginWalletRead(owner, f.state.incarnation))).toBe(true);
    expect((await f.queue.walletSnapshot(owner)).wallet).toBeNull(); expect((await f.queue.entries(owner))[0].operation).toEqual(operation);
  });
  it("wipes financial cache with all nine private stores on logout or session/device revocation", async () => {
    const f = await setup(); await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId); await f.queue.wipe(owner);
    for (const table of f.queue.tables) expect(await table.count()).toBe(0);
  });
  it("does not let a delayed allowed response restore financial data after a newer permission denial", async () => {
    const f = await setup(); await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId);
    const oldRequest = await f.queue.beginWalletRead(owner, f.state.incarnation);
    const delayed = () => f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, oldRequest);
    await f.queue.saveWalletSnapshot(owner, null, f.state.incarnation, await f.queue.beginWalletRead(owner, f.state.incarnation));
    expect(await delayed()).toBe(false); expect((await f.queue.walletSnapshot(owner)).wallet).toBeNull();
  });
  it("rejects an in-flight read across a scope cursor reset and accepts only a fresh read", async () => {
    const f = await setup();
    await f.queue.invalidateCache(owner);
    await f.queue.publishCache(owner, (await f.queue.readCache(owner)).state!, [], [], "new-scope", new Date().toISOString());
    expect(await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, f.readId)).toBe(false);
    expect((await f.queue.walletSnapshot(owner)).wallet).toBeNull();
    const fresh = await f.queue.beginWalletRead(owner, f.state.incarnation);
    expect(await f.queue.saveWalletSnapshot(owner, f.snapshot, f.state.incarnation, fresh)).toBe(true);
    expect((await f.queue.walletSnapshot(owner)).wallet).toEqual(f.snapshot);
  });
});
