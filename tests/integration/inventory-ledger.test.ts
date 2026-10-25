import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { provisionIntegrationRole } from "./support/database-role";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { InventoryRepository } from "@/modules/inventory/infrastructure/inventory-repository";
import { inventoryMinimumsSchema } from "@/platform/config/rule-registry";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Linen ledger integration", baseCurrency: "MAD" } });
  return withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Linen employee" } });
    const actor = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Linen villa", addressLine1: "Test", city: "Marrakech",
      propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const item = await tx.inventoryItem.create({ data: { organizationId: org, key: "bath_towel", category: "LINEN", unit: "pieces", labels: { en: "Bath towel", fr: "Serviette" } } });
    const location = await tx.inventoryLocation.create({ data: { organizationId: org, kind: "PROPERTY", propertyId: property.id, label: property.name } });
    const cursor = await tx.inventoryStockCursor.create({ data: { organizationId: org, locationId: location.id, itemId: item.id } });
    return { org, actor, property, item, location, cursor };
  });
}
function countData(f: Awaited<ReturnType<typeof fixture>>, quantity: bigint) {
  return { organizationId: f.org, propertyId: f.property.id, locationId: f.location.id, itemId: f.item.id,
    actorId: f.actor.id, expectedRevision: 0n, revision: 1n, expectedQuantity: "0", countedQuantity: quantity,
    note: "Physical count for assigned field work", deviceId: "stocktake-test-device", clientOpId: randomUUID(), configSnapshot: {} };
}
async function observe(f: Awaited<ReturnType<typeof fixture>>, quantity: bigint) {
  return withTenant(db, f.org, async tx => {
    const observation = await tx.inventoryStocktake.create({ data: countData(f, quantity) });
    if (quantity !== 0n) await tx.inventoryMovement.create({ data: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id,
      stocktakeId: observation.id, actorId: f.actor.id, kind: "STOCKTAKE_ADJUSTMENT", revision: 1n, quantityDelta: quantity.toString() } });
    await tx.inventoryStockCursor.update({ where: { organizationId_locationId_itemId: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id } }, data: { revision: 1n } });
    await writeAuditEvent(tx, { organizationId: f.org, actorId: f.actor.id, action: "inventory.stocktake.record", resourceType: "inventory_stocktake",
      resourceId: observation.id, propertyScopeId: f.property.id, before: { quantity: "0", revision: "0" }, after: { quantity: quantity.toString(), revision: "1" },
      reason: observation.note, requestId: randomUUID(), occurredAt: new Date() });
    return observation;
  });
}

describe("tenant-isolated append-only stock ledger", () => {
  beforeAll(async () => {
    if (!url) return;
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
    expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it.skipIf(!url)("updates display metadata while preserving item and location identity", async () => {
    const f = await fixture();
    await withTenant(db, f.org, async tx => {
      expect((await tx.inventoryItem.update({ where: { id: f.item.id }, data: { labels: { en: "Bath linen", fr: "Linge de bain" } } })).key).toBe(f.item.key);
      expect((await tx.inventoryLocation.update({ where: { id: f.location.id }, data: { label: "Updated villa name" } })).propertyId).toBe(f.property.id);
    });
  });
  it.skipIf(!url)("forces tenant RLS on every new table and rejects cross-tenant stream references", async () => {
    const a = await fixture(), b = await fixture();
    await withTenant(db, a.org, async tx => {
      expect(await tx.inventoryItem.findMany({ where: { id: b.item.id } })).toEqual([]);
      expect(await tx.inventoryLocation.findMany({ where: { id: b.location.id } })).toEqual([]);
      const tables = await tx.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE relname IN ('inventory_item','inventory_location','inventory_stock_cursor','inventory_stocktake','inventory_movement')`;
      expect(tables).toHaveLength(5); expect(tables.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    });
    await expect(withTenant(db, a.org, tx => tx.inventoryStockCursor.create({ data: { organizationId: a.org, locationId: b.location.id, itemId: a.item.id } }))).rejects.toMatchObject({ code: "P2003" });
    expect(await db.inventoryItem.findMany()).toEqual([]); expect(await db.inventoryLocation.findMany()).toEqual([]);
    expect(await db.inventoryStockCursor.findMany()).toEqual([]); expect(await db.inventoryStocktake.findMany()).toEqual([]); expect(await db.inventoryMovement.findMany()).toEqual([]);
  });
  it.skipIf(!url)("rejects identity rewrites, business deletion and cursor advancement without history", async () => {
    const f = await fixture();
    await expect(withTenant(db, f.org, tx => tx.inventoryItem.update({ where: { id: f.item.id }, data: { unit: "different" } }))).rejects.toThrow("identity is immutable");
    await expect(withTenant(db, f.org, tx => tx.inventoryItem.delete({ where: { id: f.item.id } }))).rejects.toThrow("cannot be deleted");
    await expect(withTenant(db, f.org, tx => tx.inventoryLocation.delete({ where: { id: f.location.id } }))).rejects.toThrow("cannot be deleted");
    await expect(withTenant(db, f.org, tx => tx.inventoryStockCursor.update({ where: { organizationId_locationId_itemId: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id } }, data: { revision: 1n } }))).rejects.toThrow("requires an immutable observation");
    await withTenant(db, f.org, async tx => {
      expect((await tx.inventoryItem.findUniqueOrThrow({ where: { id: f.item.id } })).unit).toBe("pieces");
      expect((await tx.inventoryStockCursor.findUniqueOrThrow({ where: { organizationId_locationId_itemId: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id } } })).revision).toBe(0n);
    });
  });
  it.skipIf(!url)("rolls back a stocktake missing its required physical movement", async () => {
    const f = await fixture();
    await expect(withTenant(db, f.org, async tx => {
      await tx.inventoryStocktake.create({ data: countData(f, 12n) });
      await tx.inventoryStockCursor.update({ where: { organizationId_locationId_itemId: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id } }, data: { revision: 1n } });
    })).rejects.toThrow("must commit together");
    await withTenant(db, f.org, async tx => { expect(await tx.inventoryStocktake.count()).toBe(0); expect(await tx.inventoryMovement.count()).toBe(0); });
  });
  it.skipIf(!url)("requires an audit even when a physical observation has no quantity delta", async () => {
    const f = await fixture();
    await expect(withTenant(db, f.org, async tx => {
      await tx.inventoryStocktake.create({ data: countData(f, 0n) });
      await tx.inventoryStockCursor.update({ where: { organizationId_locationId_itemId: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id } }, data: { revision: 1n } });
    })).rejects.toThrow("audit is required");
    await withTenant(db, f.org, async tx => { expect(await tx.inventoryStocktake.count()).toBe(0); expect(await tx.inventoryMovement.count()).toBe(0); });
  });
  it.skipIf(!url)("commits one exact audited observation and immutable derived movement above the JavaScript integer range", async () => {
    const f = await fixture(), quantity = 9_007_199_254_740_993n, observation = await observe(f, quantity);
    const movement = await withTenant(db, f.org, async tx => {
      const rows = await tx.inventoryMovement.findMany(); expect(rows).toHaveLength(1);
      expect((await tx.inventoryStocktake.findUniqueOrThrow({ where: { id: observation.id } })).countedQuantity).toBe(quantity);
      expect((await tx.inventoryMovement.aggregate({ _sum: { quantityDelta: true } }))._sum.quantityDelta?.toFixed(0)).toBe(quantity.toString());
      expect(await tx.auditLog.count({ where: { resourceId: observation.id, action: "inventory.stocktake.record", actorId: f.actor.id } })).toBe(1);
      return rows[0];
    });
    await expect(withTenant(db, f.org, tx => tx.inventoryStocktake.update({ where: { id: observation.id }, data: { countedQuantity: 12n } }))).rejects.toThrow("append only");
    await expect(withTenant(db, f.org, tx => tx.inventoryStocktake.delete({ where: { id: observation.id } }))).rejects.toThrow("append only");
    await expect(withTenant(db, f.org, tx => tx.inventoryMovement.update({ where: { id: movement.id }, data: { quantityDelta: "12" } }))).rejects.toThrow("append only");
    await expect(withTenant(db, f.org, tx => tx.inventoryMovement.delete({ where: { id: movement.id } }))).rejects.toThrow("append only");
  });
  it.skipIf(!url)("serializes concurrent stale observations without a second movement or audit", async () => {
    const f = await fixture(), results = await Promise.allSettled([observe(f, 12n), observe(f, 15n)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected");
    expect(failed?.status === "rejected" ? String(failed.reason) : "").toContain("revision conflict");
    await withTenant(db, f.org, async tx => {
      const observations = await tx.inventoryStocktake.findMany(); expect(observations).toHaveLength(1);
      expect(await tx.inventoryMovement.count()).toBe(1); expect(await tx.auditLog.count({ where: { action: "inventory.stocktake.record" } })).toBe(1);
      expect((await tx.inventoryMovement.aggregate({ _sum: { quantityDelta: true } }))._sum.quantityDelta?.toFixed(0)).toBe(observations[0].countedQuantity.toString());
      expect((await tx.inventoryStockCursor.findUniqueOrThrow({ where: { organizationId_locationId_itemId: { organizationId: f.org, locationId: f.location.id, itemId: f.item.id } } })).revision).toBe(1n);
    });
  });
  it.skipIf(!url)("reads exact stock snapshots at server recording time without trusting a future client clock", async () => {
    const f = await fixture(), quantity = "9007199254740993", now = new Date();
    await withTenant(db, f.org, async tx => {
      const repository = new InventoryRepository(tx, f.org);
      await repository.lockBatch([{ propertyId: f.property.id, itemKey: f.item.key }]);
      expect(await repository.position(f.location.id, f.item.id)).toEqual({ quantity: "0", revision: "0" });
      const task = await tx.operationTask.create({ data: { organizationId: f.org, propertyId: f.property.id,
        assignedToUserAccountId: f.actor.id, assignedToPersonId: f.actor.personId, state: "ASSIGNED", type: "INSPECTION",
        dueDate: new Date("2027-01-10"), titleTranslations: { en: "Count linen", fr: "Compter le linge" }, idempotencyKey: randomUUID(), createdBy: f.actor.id } });
      const rule = await tx.configRule.create({ data: { organizationId: f.org, key: "inventory.minimums", scopeType: "property", scopeId: f.property.id,
        value: { minimums: [{ item: f.item.key, quantity: 8, category: "LINEN", unit: "pieces" }] }, effectiveFrom: new Date("2020-01-01"),
        version: 1, reason: "Explicit linen configuration", createdBy: f.actor.id } });
      const recorded = await repository.record({ propertyId: f.property.id, taskId: task.id, locationId: f.location.id, itemId: f.item.id,
        actorId: f.actor.id, configRuleId: rule.id, expected: { quantity: "0", revision: "0" }, countedQuantity: quantity, delta: quantity,
        note: "Observed physical linen", deviceId: "stocktake-repository-device", clientOpId: randomUUID(), clientCreatedAt: new Date("2077-01-01"),
        configSnapshot: { configRuleId: rule.id, configVersion: rule.version, minimum: "8" }, receivedAt: now });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.actor.id, action: "inventory.stocktake.record", resourceType: "inventory_stocktake",
        resourceId: recorded.observation.id, propertyScopeId: f.property.id, reason: recorded.observation.note, requestId: randomUUID(), occurredAt: now,
        before: { quantity: "0", revision: "0" }, after: recorded.position });
      expect(recorded.position).toEqual({ quantity, revision: "1" });
      expect(recorded.observation.receivedAt).toEqual(now); expect(recorded.observation.clientCreatedAt).toEqual(new Date("2077-01-01"));
      const streams = [{ propertyId: f.property.id, itemKey: f.item.key }, { propertyId: f.property.id, itemKey: "missing_item" }];
      expect(await repository.snapshotPositions(streams, new Date(now.getTime() - 1))).toEqual([
        { propertyId: f.property.id, itemKey: f.item.key, quantity: "0", revision: "0" },
        { propertyId: f.property.id, itemKey: "missing_item", quantity: "0", revision: "0" }
      ]);
      expect(await repository.snapshotPositions(streams, now)).toEqual([
        { propertyId: f.property.id, itemKey: f.item.key, quantity, revision: "1" },
        { propertyId: f.property.id, itemKey: "missing_item", quantity: "0", revision: "0" }
      ]);
    });
  });
  it.skipIf(!url)("accepts the full existing configured item-key format without inventing a narrower inventory identity", async () => {
    const f = await fixture(), key = `2${"a".repeat(119)}`;
    const configured = inventoryMinimumsSchema.parse({ minimums: [{ item: key, quantity: 0, category: "LINEN", unit: "pieces" }] }).minimums[0];
    await withTenant(db, f.org, async tx => {
      expect((await tx.inventoryItem.create({ data: { organizationId: f.org, key: configured.item, category: "LINEN", unit: "pieces",
        labels: { en: "Configured linen", fr: "Linge configuré" } } })).key).toBe(key);
    });
  });
});
