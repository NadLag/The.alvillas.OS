import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { provisionIntegrationRole } from "./support/database-role";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { prepareFieldStocktakeBatch, recordFieldStocktakeInTransaction } from "@/platform/inventory/field-stocktake-service";
import { StocktakeConflictError } from "@/modules/inventory/domain/stocktake";
import { FieldStocktakeUnavailableError, type FieldStocktakePayload } from "@/platform/inventory/field-stocktake";
import { ReservationAuthorizationError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { pushSyncOps } from "@/modules/reservations/application/sync-service";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { InventoryRepository } from "@/modules/inventory/infrastructure/inventory-repository";
import { pullFieldWork } from "@/modules/reservations/application/field-pull-service";
import { fieldPullInputSchema } from "@/modules/reservations/domain/field-pull";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
const catalog = (minimum = 8, unit = "pieces") => ({ minimums: [{ item: "bath_towel", quantity: minimum, category: "LINEN",
  unit, name: { en: "Bath towel", fr: "Serviette de bain", ar: "منشفة حمام" } }] });
async function fixture(organizationId?: string) {
  const org = organizationId ?? randomUUID();
  if (!organizationId) await admin.organization.create({ data: { id: org, name: "Field stocktake integration", baseCurrency: "MAD" } });
  return withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Assigned linen worker" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Configured linen villa", addressLine1: "Test",
      city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const task = await tx.operationTask.create({ data: { organizationId: org, propertyId: property.id, assignedToUserAccountId: account.id,
      assignedToPersonId: person.id, state: "ASSIGNED", type: "INSPECTION", dueDate: new Date("2027-01-10"),
      titleTranslations: { en: "Observe linen", fr: "Compter le linge" }, idempotencyKey: randomUUID(), createdBy: account.id } });
    const rule = await new ConfigRuleRepository(tx, org).createVersion({ key: "inventory.minimums", scopeType: "property", scopeId: property.id,
      value: catalog(), effectiveFrom: new Date("2020-01-01"), createdBy: account.id, reason: "Explicit property linen catalog" });
    const ctx: ReservationActorContext = { organizationId: org, actorId: account.id, personId: person.id, authContext: { organizationId: org,
      userAccountId: account.id, personId: person.id, permissions: new Set(["task:view", "task:edit"]),
      scopes: [{ organizationId: org, scopeType: "job", scopeId: task.id }] } };
    const input: FieldStocktakePayload = { taskId: task.id, itemKey: "bath_towel", expectedQuantity: "0", expectedRevision: "0", countedQuantity: "3",
      unit: "pieces", catalogRuleId: rule.id, catalogVersion: rule.version, note: "Physical count by assigned employee" };
    const taskHistory = await tx.operationTaskEvent.findMany({ where: { taskId: task.id }, orderBy: { version: "asc" } });
    return { org, person, account, property, task, rule, ctx, input, taskHistory };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function record(f: Fixture, input = f.input, ctx = f.ctx, clientCreatedAt: Date | null = null) {
  return withTenant(db, ctx.organizationId, async tx => {
    const batch = await prepareFieldStocktakeBatch(ctx, [input], tx);
    return recordFieldStocktakeInTransaction(ctx, input, { deviceId: "stocktake-service-device", clientOpId: randomUUID(), clientCreatedAt },
      tx, batch, { requestId: randomUUID(), ipAddress: null });
  });
}
async function revise(f: Fixture, value: unknown, effectiveFrom = new Date("2021-01-01"), scopeType = "property", scopeId = f.property.id) {
  return withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "inventory.minimums", scopeType, scopeId,
    value, effectiveFrom, createdBy: f.account.id, reason: "Explicit changed catalog" }));
}
async function empty(f: Fixture) {
  await withTenant(db, f.org, async tx => {
    expect(await tx.inventoryItem.count()).toBe(0); expect(await tx.inventoryLocation.count()).toBe(0);
    expect(await tx.inventoryStocktake.count()).toBe(0); expect(await tx.inventoryMovement.count()).toBe(0);
    expect(await tx.outboxEvent.count()).toBe(0); expect(await tx.auditLog.count()).toBe(0);
  });
}
function syncInput(f: Fixture, payload = f.input, clientOpId: string = randomUUID(), deviceId: string = randomUUID()) {
  return syncPushInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, device_id: deviceId, op_schema_version: 1,
    ops: [{ type: "field_stocktake.record", client_op_id: clientOpId, client_created_at: "2077-01-01T00:00:00Z", payload }] });
}
const push = (f: Fixture, input = syncInput(f), ctx = f.ctx) => pushSyncOps(ctx, input, { db, requestId: randomUUID() });
function pull(f: Fixture, extra: Record<string, unknown> = {}, ctx = f.ctx) {
  return pullFieldWork(ctx, fieldPullInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, mode: "assigned", ...extra }),
    { db, env: { NODE_ENV: "test", ENCRYPTION_KEYS: `local:${Buffer.alloc(32, 0x31).toString("base64")}` } });
}
async function inventoryFixture(category: "CONSUMABLE" | "EQUIPMENT") {
  const f = await fixture(), item = category === "CONSUMABLE" ? "soap" : "vacuum";
  const value = { minimums: [{ ...catalog().minimums[0], item, category }] }, rule = await revise(f, value);
  return { ...f, rule, input: { ...f.input, itemKey: item, catalogRuleId: rule.id, catalogVersion: rule.version }, value };
}
async function whileLocked(f: Fixture, lock: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>, action: () => Promise<unknown>) {
  let release!: () => void, acquired!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
  const holder = withTenant(db, f.org, async tx => { await lock(tx); acquired(); await held; });
  await ready;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Unrelated stocktake was blocked")), 2_000); })]); }
  finally { clearTimeout(timer); release(); await holder; }
}

describe("assigned field stocktakes on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url) return;
    if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Stocktake fixtures require an isolated local database");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
    expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it.skipIf(!url)("materializes only the configured linen identity and commits one audit, movement and each scoped event without completing work", async () => {
    const f = await fixture(), result = await record(f, f.input, f.ctx, new Date("2077-01-01"));
    expect(result.serverVersion).toBe("1");
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryItem.findFirst()).toMatchObject({ key: "bath_towel", category: "LINEN", unit: "pieces", sourceConfigRuleId: f.rule.id });
      expect(await tx.inventoryLocation.findFirst()).toMatchObject({ kind: "PROPERTY", propertyId: f.property.id, label: f.property.name });
      const row = await tx.inventoryStocktake.findUniqueOrThrow({ where: { id: result.stocktakeId } });
      expect(row).toMatchObject({ actorId: f.account.id, taskId: f.task.id, countedQuantity: 3n, configRuleId: f.rule.id, clientCreatedAt: new Date("2077-01-01") });
      expect(row.receivedAt.getTime()).toBeLessThan(Date.now() + 1_000);
      expect(row.configSnapshot).toMatchObject({ appliedCatalog: { id: f.rule.id, version: 1 }, reportedCatalog: { id: f.rule.id, version: 1 },
        item: { key: "bath_towel", unit: "pieces", minimum: "8" } });
      expect((await tx.inventoryMovement.aggregate({ _sum: { quantityDelta: true } }))._sum.quantityDelta?.toFixed(0)).toBe("3");
      expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record", resourceId: row.id, propertyScopeId: f.property.id } })).toBe(1);
      const events = await tx.outboxEvent.findMany(); expect(events.map(event => event.type).sort()).toEqual(["InventoryBelowMinimum", "StocktakeVariance"]);
      for (const event of events) expect(event.payload).toMatchObject({ propertyId: f.property.id, taskId: f.task.id,
        inventory: { item: "bath_towel", quantity: "3" }, stocktake: { id: row.id, expected: "0", actual: "3", delta: "3", revision: "1" } });
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ state: "ASSIGNED", completedAt: null });
      expect(await tx.operationTaskEvent.findMany({ where: { taskId: f.task.id }, orderBy: { version: "asc" } })).toEqual(f.taskHistory);
    });
  });
  it.skipIf(!url)("denies missing permissions, changed actor/person and cross-tenant contexts without catalog or ledger writes", async () => {
    const f = await fixture(), foreign = await fixture();
    for (const permissions of [new Set<string>(), new Set(["task:view"]), new Set(["task:edit"])])
      await expect(record(f, f.input, { ...f.ctx, authContext: { ...f.ctx.authContext, permissions } })).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(record(f, f.input, { ...f.ctx, actorId: randomUUID() })).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(record(f, f.input, { ...f.ctx, personId: randomUUID() })).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(record(f, f.input, foreign.ctx)).rejects.toBeInstanceOf(ReservationNotFoundError);
    await empty(f); await empty(foreign);
  });
  it.skipIf(!url)("denies another assignment, another job grant and a reassigned or archived task", async () => {
    const f = await fixture();
    await expect(record(f, f.input, { ...f.ctx, authContext: { ...f.ctx.authContext,
      scopes: [{ organizationId: f.org, scopeType: "job", scopeId: randomUUID() }] } })).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: null } }));
    await expect(record(f)).rejects.toBeInstanceOf(ReservationNotFoundError);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { assignedToUserAccountId: f.account.id, archivedAt: new Date() } }));
    await expect(record(f)).rejects.toBeInstanceOf(ReservationNotFoundError);
    await empty(f);
  });
  it.skipIf(!url)("rejects invented items and unavailable, changed-unit, future or draft catalog references before materialization", async () => {
    const f = await fixture();
    await expect(record(f, { ...f.input, itemKey: "invented_item" })).rejects.toEqual(new FieldStocktakeUnavailableError("ITEM_UNAVAILABLE"));
    await expect(record(f, { ...f.input, catalogVersion: 2 })).rejects.toEqual(new FieldStocktakeUnavailableError("CATALOG_CHANGED"));
    const future = await revise(f, catalog(), new Date("2077-01-01"));
    await expect(record(f, { ...f.input, catalogRuleId: future.id, catalogVersion: future.version })).rejects.toEqual(new FieldStocktakeUnavailableError("CATALOG_CHANGED"));
    const draft = await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "inventory.minimums", scopeType: "property", scopeId: f.property.id,
      value: catalog(), effectiveFrom: new Date("2021-01-01"), lifecycle: "DRAFT", createdBy: f.account.id, reason: "Unapproved catalog draft" }));
    await expect(record(f, { ...f.input, catalogRuleId: draft.id, catalogVersion: draft.version })).rejects.toEqual(new FieldStocktakeUnavailableError("CATALOG_CHANGED"));
    await revise(f, catalog(8, "sets"));
    await expect(record(f)).rejects.toEqual(new FieldStocktakeUnavailableError("UNIT_CHANGED"));
    await empty(f);
  });
  it.skipIf(!url)("uses the effective agreement and current catalog version while retaining the employee's original compatible catalog provenance", async () => {
    const f = await fixture();
    const agreement = await withTenant(db, f.org, tx => tx.managementAgreement.create({ data: { organizationId: f.org, propertyId: f.property.id,
      reference: "LINEN-AGREEMENT", status: "ACTIVE", effectiveFrom: new Date("2022-01-01") } }));
    const rule = await revise(f, catalog(2), new Date("2022-01-01"), "agreement", agreement.id);
    const result = await record(f);
    await withTenant(db, f.org, async tx => {
      const observation = await tx.inventoryStocktake.findUniqueOrThrow({ where: { id: result.stocktakeId } });
      expect(observation).toMatchObject({ configRuleId: rule.id,
        configSnapshot: { appliedCatalog: { id: rule.id, scopeType: "agreement", scopeId: agreement.id },
          reportedCatalog: { id: f.rule.id, version: f.rule.version }, item: { minimum: "2" } } });
      expect(z.object({ scopes: z.array(z.object({ scopeType: z.string(), scopeId: z.string().nullable() })) }).parse(observation.configSnapshot).scopes)
        .toContainEqual({ scopeType: "agreement", scopeId: agreement.id });
      expect(await tx.outboxEvent.count({ where: { type: "InventoryBelowMinimum" } })).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: "StocktakeVariance" } })).toBe(1);
    });
  });
  it.skipIf(!url)("rejects a catalog from an expired agreement even when its linen identity still matches", async () => {
    const f = await fixture();
    const agreement = await withTenant(db, f.org, tx => tx.managementAgreement.create({ data: { organizationId: f.org, propertyId: f.property.id,
      reference: "OLD-LINEN", status: "ACTIVE", effectiveFrom: new Date("2020-01-01"), effectiveTo: new Date("2021-01-01") } }));
    const old = await revise(f, catalog(), new Date("2020-01-01"), "agreement", agreement.id);
    await expect(record(f, { ...f.input, catalogRuleId: old.id, catalogVersion: old.version })).rejects.toEqual(new FieldStocktakeUnavailableError("CATALOG_CHANGED"));
    await empty(f);
  });
  it.skipIf(!url)("records an unchanged observation without a movement or variance and honors an explicit zero minimum", async () => {
    const f = await fixture(); await revise(f, catalog(0));
    await record(f, { ...f.input, countedQuantity: "0" });
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryStocktake.count()).toBe(1); expect(await tx.inventoryMovement.count()).toBe(0);
      expect(await tx.outboxEvent.count()).toBe(0); expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record" } })).toBe(1);
    });
  });
  it.skipIf(!url)("preserves the first observation under simultaneous stale counts and never silently rebases the second", async () => {
    const f = await fixture(), results = await Promise.allSettled([record(f), record(f, { ...f.input, countedQuantity: "5" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected"); expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(StocktakeConflictError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryStocktake.count()).toBe(1); expect(await tx.inventoryMovement.count()).toBe(1);
      expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record" } })).toBe(1); expect(await tx.outboxEvent.count()).toBe(2);
    });
  });
  it.skipIf(!url)("acknowledges concurrent duplicate delivery exactly once and rejects changed content under the original operation key", async () => {
    const f = await fixture(), input = syncInput(f), results = await Promise.all([push(f, input), push(f, input)]);
    expect(results.map(result => result.results[0].status).sort()).toEqual(["APPLIED", "DUPLICATE"]);
    const changed = syncPushInputSchema.parse({ ...input, ops: [{ ...input.ops[0], payload: { ...f.input, countedQuantity: "4" } }] });
    expect((await push(f, changed)).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_IDEMPOTENCY_KEY_REUSED" });
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryStocktake.count()).toBe(1); expect(await tx.inventoryMovement.count()).toBe(1);
      expect(await tx.syncOp.count()).toBe(1); expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record" } })).toBe(1);
      expect(await tx.outboxEvent.count()).toBe(2);
    });
  });
  it.skipIf(!url)("durably returns a stale quantity and revision until an explicit new review submits a new operation key", async () => {
    const f = await fixture(), applied = syncInput(f), stale = syncInput(f, { ...f.input, countedQuantity: "5" });
    expect((await push(f, applied)).results[0].status).toBe("APPLIED");
    const conflict = (await push(f, stale)).results[0];
    expect(conflict).toMatchObject({ status: "CONFLICT", server_version: "1", error_code: "STOCKTAKE_CONFLICT",
      stocktake: { expected: { quantity: "0", revision: "0" }, current: { quantity: "3", revision: "1" } } });
    expect((await push(f, stale)).results[0]).toEqual(conflict);
    const reviewed = syncInput(f, { ...f.input, expectedQuantity: "3", expectedRevision: "1", countedQuantity: "5", note: "Recount after explicit conflict review" },
      randomUUID(), stale.device_id);
    expect((await push(f, reviewed)).results[0]).toMatchObject({ status: "APPLIED", server_version: "2" });
    expect((await push(f, stale)).results[0]).toEqual(conflict);
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryStocktake.count()).toBe(2); expect(await tx.syncOp.count()).toBe(3);
      expect((await tx.inventoryMovement.aggregate({ _sum: { quantityDelta: true } }))._sum.quantityDelta?.toFixed(0)).toBe("5");
      expect(await tx.syncOp.findFirst({ where: { clientOpId: stale.ops[0].client_op_id } })).toMatchObject({ status: "CONFLICT", payload: stale.ops[0].payload });
    });
  });
  it.skipIf(!url)("keeps sequential counts from the same offline base as an explicit conflict within one batch", async () => {
    const f = await fixture(), input = syncInput(f), second = syncInput(f, { ...f.input, countedQuantity: "7" });
    const batch = syncPushInputSchema.parse({ ...input, ops: [...input.ops, ...second.ops] });
    expect((await push(f, batch)).results.map(result => result.status)).toEqual(["APPLIED", "CONFLICT"]);
    expect((await push(f, batch)).results.map(result => result.status)).toEqual(["DUPLICATE", "CONFLICT"]);
    await withTenant(db, f.org, async tx => { expect(await tx.inventoryStocktake.count()).toBe(1); expect(await tx.syncOp.count()).toBe(2); });
  });
  it.skipIf(!url)("persists rejection after current permission or catalog removal and preserves the employee's queued intent", async () => {
    const f = await fixture(), denied = syncInput(f);
    expect((await push(f, denied, { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["task:view"]) } })).results[0])
      .toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    expect((await push(f, denied)).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    await revise(f, { minimums: [] });
    const removed = syncInput(f);
    expect((await push(f, removed)).results[0]).toMatchObject({ status: "REJECTED", error_code: "STOCKTAKE_ITEM_UNAVAILABLE" });
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryStocktake.count()).toBe(0); expect(await tx.outboxEvent.count()).toBe(0);
      expect(await tx.syncOp.findFirst({ where: { clientOpId: removed.ops[0].client_op_id } })).toMatchObject({ status: "REJECTED", payload: removed.ops[0].payload });
    });
  });
  it.skipIf(!url)("does not block a physical stocktake behind an unrelated crew-schedule transaction", async () => {
    const f = await fixture();
    await whileLocked(f, tx => new OperationRepository(tx, f.org).lock("crew-schedule"), async () => {
      expect((await push(f)).results[0].status).toBe("APPLIED");
    });
  });
  it.skipIf(!url)("allows another property's employee to count the same existing item while the first property's stream is locked", async () => {
    const first = await fixture(), second = await fixture(first.org);
    await record(first); await record(second);
    await whileLocked(first, tx => new InventoryRepository(tx, first.org).lockBatch([{ propertyId: first.property.id, itemKey: first.input.itemKey }]), async () => {
      expect((await push(second, syncInput(second, { ...second.input, expectedQuantity: "3", expectedRevision: "1", countedQuantity: "4" }))).results[0].status).toBe("APPLIED");
    });
  });
  it.skipIf(!url)("opts into the effective linen catalog and derived stock without changing legacy projections or leaking another tenant", async () => {
    const f = await fixture(), foreign = await fixture();
    const legacy = await pull(f); expect(legacy.tasks).toHaveLength(1); expect(legacy.tasks[0]).not.toHaveProperty("linen");
    const before = await pull(f, { include_linen: true, known_tasks: [{ id: foreign.task.id, revision: null }] });
    expect(before.tasks).toHaveLength(1); expect(before.tombstones).toEqual([foreign.task.id]);
    expect(before.tasks[0].linen).toMatchObject({ catalog: { id: f.rule.id, version: 1 }, items: [{ key: "bath_towel", quantity: "0", revision: "0", available: true }] });
    await record(f);
    const unchanged = await pull(f, { known_tasks: legacy.tasks.map(({ id, revision }) => ({ id, revision })) });
    expect(unchanged.tasks).toEqual([]); expect(unchanged.known_changes).toEqual([]);
    const changed = await pull(f, { include_linen: true, known_tasks: before.tasks.map(({ id, revision }) => ({ id, revision })) });
    expect(changed.known_changes[0].linen?.items[0]).toMatchObject({ quantity: "3", revision: "1", available: true });
    expect(changed.known_changes[0].revision).not.toBe(before.tasks[0].revision);
    expect(JSON.stringify(changed)).not.toContain(foreign.rule.id);
    expect(await withTenant(db, f.org, tx => tx.inventoryStocktake.count({ where: { organizationId: foreign.org } }))).toBe(0);
  });
  it.skipIf(!url)("publishes no invented catalog, minimum or linen identity and disables incompatible configured units", async () => {
    const f = await fixture(); await revise(f, { minimums: [] });
    expect((await pull(f, { include_linen: true })).tasks[0].linen?.items).toEqual([]);
    await revise(f, catalog()); await record(f); const next = await revise(f, catalog(8, "sets"));
    const snapshot = (await pull(f, { include_linen: true })).tasks[0].linen;
    expect(snapshot).toMatchObject({ catalog: { id: next.id, version: next.version }, items: [{ key: "bath_towel", unit: "sets", quantity: "3", revision: "1", available: false }] });
    await expect(record(f, { ...f.input, catalogRuleId: next.id, catalogVersion: next.version, unit: "sets", expectedQuantity: "3", expectedRevision: "1" }))
      .rejects.toEqual(new FieldStocktakeUnavailableError("UNIT_CHANGED"));
  });
  it.skipIf(!url)("disables field counting when the currently authorized employee only has task viewing permission", async () => {
    const f = await fixture(), viewer = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["task:view"]) } };
    const snapshot = (await pull(f, { include_linen: true }, viewer)).tasks[0];
    expect(snapshot.canEdit).toBe(false); expect(snapshot.linen?.items[0].available).toBe(false);
    await empty(f);
  });
  it.skipIf(!url)("denies a previously cached count when its assigned task is now terminal without mutating stock", async () => {
    const f = await fixture(), input = syncInput(f);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: f.task.id }, data: { state: "CANCELLED" } }));
    expect((await push(f, input)).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_NOT_ASSIGNED" });
    await withTenant(db, f.org, async tx => {
      expect(await tx.inventoryStocktake.count()).toBe(0); expect(await tx.inventoryItem.count()).toBe(0);
      expect(await tx.outboxEvent.count()).toBe(0); expect(await tx.syncOp.count({ where: { status: "REJECTED" } })).toBe(1);
    });
  });
  for (const category of ["CONSUMABLE", "EQUIPMENT"] as const) {
    it.skipIf(!url)(`records ${category} through the same immutable ledger and deduplicates concurrent deliveries`, async () => {
      const f = await inventoryFixture(category), input = syncInput(f), before = await pull(f, { include_inventory: true, include_linen: true });
      expect(before.tasks[0].inventory?.items).toMatchObject([{ key: f.input.itemKey, quantity: "0", revision: "0", available: true }]);
      expect(before.tasks[0].linen?.items).toEqual([]);
      expect((await Promise.all([push(f, input), push(f, input), push(f, input)])).map(result => result.results[0].status).sort())
        .toEqual(["APPLIED", "DUPLICATE", "DUPLICATE"]);
      const changed = await pull(f, { include_inventory: true, known_tasks: before.tasks.map(({ id, revision }) => ({ id, revision })) });
      expect(changed.known_changes[0].inventory?.items[0]).toMatchObject({ key: f.input.itemKey, quantity: "3", revision: "1" });
      await withTenant(db, f.org, async tx => {
        expect(await tx.inventoryItem.findFirst()).toMatchObject({ key: f.input.itemKey, category, unit: "pieces" });
        expect(await tx.inventoryStocktake.count()).toBe(1); expect(await tx.inventoryMovement.count()).toBe(1); expect(await tx.syncOp.count()).toBe(1);
        expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record" } })).toBe(1);
        expect((await tx.outboxEvent.findMany()).map(row => row.type).sort()).toEqual(["InventoryBelowMinimum", "StocktakeVariance"]);
        expect(await tx.operationTask.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({ state: "ASSIGNED", completedAt: null, version: f.task.version });
        expect(await tx.financialTransaction.count()).toBe(0);
      });
    });
    it.skipIf(!url)(`requires a fresh explicit ${category} review and keeps current effective agreement provenance`, async () => {
      const f = await inventoryFixture(category), original = syncInput(f), stale = syncInput(f, { ...f.input, countedQuantity: "5" });
      expect((await push(f, original)).results[0].status).toBe("APPLIED");
      expect((await push(f, stale)).results[0]).toMatchObject({ status: "CONFLICT", server_version: "1",
        stocktake: { expected: { quantity: "0", revision: "0" }, current: { quantity: "3", revision: "1" } } });
      const agreement = await withTenant(db, f.org, tx => tx.managementAgreement.create({ data: { organizationId: f.org, propertyId: f.property.id,
        reference: "INVENTORY-AGREEMENT", status: "ACTIVE", effectiveFrom: new Date("2022-01-01") } }));
      const applied = await revise(f, f.value, new Date("2022-01-01"), "agreement", agreement.id);
      const reviewed = syncInput(f, { ...f.input, countedQuantity: "5", expectedQuantity: "3", expectedRevision: "1" });
      expect((await push(f, reviewed)).results[0].status).toBe("APPLIED");
      await withTenant(db, f.org, async tx => {
        const rows = await tx.inventoryStocktake.findMany({ orderBy: { revision: "asc" } }); expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ countedQuantity: 5n, configRuleId: applied.id, configSnapshot: {
          appliedCatalog: { id: applied.id, scopeType: "agreement", scopeId: agreement.id }, reportedCatalog: { id: f.rule.id, version: f.rule.version }, item: { category } } });
        expect(await tx.syncOp.count({ where: { status: "CONFLICT" } })).toBe(1);
      });
    });
    it.skipIf(!url)(`denies ${category} writes for read-only, wrong-job and foreign-tenant actors`, async () => {
      const f = await inventoryFixture(category), foreign = await fixture();
      const viewer = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["task:view"]) } };
      expect((await pull(f, { include_inventory: true }, viewer)).tasks[0].inventory?.items[0].available).toBe(false);
      await expect(record(f, f.input, viewer)).rejects.toBeInstanceOf(ReservationAuthorizationError);
      await expect(record(f, f.input, { ...f.ctx, authContext: { ...f.ctx.authContext,
        scopes: [{ organizationId: f.org, scopeType: "job", scopeId: randomUUID() }] } })).rejects.toBeInstanceOf(ReservationAuthorizationError);
      await expect(record(f, f.input, foreign.ctx)).rejects.toBeInstanceOf(ReservationNotFoundError);
      await empty(f); await empty(foreign);
    });
  }
  it.skipIf(!url)("partitions one explicit effective catalog into linen and inventory without inventing missing categories or changing legacy revisions", async () => {
    const f = await fixture(), foreign = await fixture(), linenOnly = await pull(f, { include_linen: true });
    await revise(f, { minimums: [...catalog().minimums, { item: "soap", quantity: 4, category: "CONSUMABLE", unit: "bottles" },
      { item: "vacuum", quantity: 1, category: "EQUIPMENT", unit: "pieces" }, { item: "unclassified", quantity: 7 }] });
    const mixed = await pull(f, { include_inventory: true, include_linen: true, known_tasks: [{ id: foreign.task.id, revision: null }] });
    expect(mixed.tasks[0].linen?.items.map(item => item.key)).toEqual(["bath_towel"]);
    expect(mixed.tasks[0].inventory?.items.map(item => item.key)).toEqual(["soap", "vacuum"]); expect(mixed.tombstones).toEqual([foreign.task.id]);
    expect((await pull(f)).tasks[0]).not.toHaveProperty("inventory");
    const justLinen = await pull(f, { include_linen: true }); expect(justLinen.tasks[0]).not.toHaveProperty("inventory");
    expect(linenOnly.tasks[0].linen?.items[0].quantity).toBe("0");
    await expect(record(f, { ...f.input, itemKey: "unclassified", catalogRuleId: mixed.tasks[0].inventory!.catalog!.id,
      catalogVersion: mixed.tasks[0].inventory!.catalog!.version })).rejects.toEqual(new FieldStocktakeUnavailableError("ITEM_UNAVAILABLE"));
    expect(JSON.stringify(mixed)).not.toContain(foreign.property.id); await empty(f);
  });
  it.skipIf(!url)("rejects category changes before and after materialization rather than recategorizing existing inventory", async () => {
    const f = await inventoryFixture("CONSUMABLE");
    const changed = await revise(f, { minimums: [{ ...f.value.minimums[0], category: "EQUIPMENT" }] });
    await expect(record(f)).rejects.toEqual(new FieldStocktakeUnavailableError("CATALOG_CHANGED")); await empty(f);
    await record(f, { ...f.input, catalogRuleId: changed.id, catalogVersion: changed.version });
    const back = await revise(f, f.value, new Date("2023-01-01"));
    expect((await pull(f, { include_inventory: true })).tasks[0].inventory?.items[0].available).toBe(false);
    await expect(record(f, { ...f.input, expectedQuantity: "3", expectedRevision: "1", catalogRuleId: back.id, catalogVersion: back.version }))
      .rejects.toEqual(new FieldStocktakeUnavailableError("ITEM_UNAVAILABLE"));
    await withTenant(db, f.org, async tx => { expect(await tx.inventoryStocktake.count()).toBe(1); expect(await tx.inventoryItem.findFirst()).toMatchObject({ category: "EQUIPMENT" }); });
  });
  it.skipIf(!url)("batches both stocktake surfaces across properties without adding queries per job", async () => {
    const f = await inventoryFixture("CONSUMABLE"), ctx = { ...f.ctx, authContext: { ...f.ctx.authContext, scopes: [{ organizationId: f.org }] } };
    const scoped = new URL(url!); scoped.username = scoped.password = "alvillas_ops_tests";
    const measured = new PrismaClient({ datasourceUrl: scoped.toString(), log: [{ emit: "event", level: "query" }] }); let queries = 0;
    measured.$on("query", () => { queries += 1; });
    const input = fieldPullInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, mode: "assigned", include_linen: true, include_inventory: true });
    const run = () => pullFieldWork(ctx, input, { db: measured, env: { NODE_ENV: "test", ENCRYPTION_KEYS: `local:${Buffer.alloc(32, 0x31).toString("base64")}` } });
    try {
      expect((await run()).tasks).toHaveLength(1); const single = queries;
      for (let index = 0; index < 12; index += 1) {
        const other = await fixture(f.org);
        await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: other.task.id }, data: { assignedToUserAccountId: f.account.id, assignedToPersonId: f.person.id } }));
      }
      queries = 0; const many = await run(); expect(many.tasks).toHaveLength(13);
      expect(many.tasks.every(task => task.linen && task.inventory)).toBe(true); expect(queries).toBeLessThanOrEqual(single + 2);
    } finally { await measured.$disconnect(); }
  });
});
