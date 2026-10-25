import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { StockPosition } from "../domain/stocktake";

export class InventoryRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  private async lock(key: string, shared: boolean) {
    const name = `inventory:${this.organizationId}:${key}`;
    if (shared) await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${name},0))`);
    else await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${name},0))`);
  }

  async lockBatch(streams: Array<{ propertyId: string; itemKey: string }>) {
    const keys = [...new Set(streams.map(row => row.itemKey))].sort();
    const properties = [...new Set(streams.map(row => row.propertyId))].sort();
    const [items, locations] = await Promise.all([
      this.tx.inventoryItem.findMany({ where: { organizationId: this.organizationId, key: { in: keys } }, select: { key: true } }),
      this.tx.inventoryLocation.findMany({ where: { organizationId: this.organizationId, propertyId: { in: properties } }, select: { propertyId: true } })
    ]);
    const existingItems = new Set(items.map(row => row.key)), existingLocations = new Set(locations.map(row => row.propertyId));
    // Existing catalog identities can be shared across properties. Only their
    // first materialization needs an exclusive catalog/location lock.
    for (const key of keys) await this.lock(`catalog:${key}`, existingItems.has(key));
    for (const property of properties) await this.lock(`location:${property}`, existingLocations.has(property));
    for (const key of [...new Set(streams.map(row => `stock:${row.propertyId}:${row.itemKey}`))].sort()) await this.lock(key, false);
  }

  tasks(ids: string[], visibility: Prisma.OperationTaskWhereInput) {
    return this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null,
      property: { archivedAt: null }, AND: [visibility] }, select: { id: true, propertyId: true } });
  }
  property(id: string) {
    return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, select: { id: true, name: true } });
  }
  item(key: string) {
    return this.tx.inventoryItem.findUnique({ where: { organizationId_key: { organizationId: this.organizationId, key } } });
  }
  propertyLocation(propertyId: string) {
    return this.tx.inventoryLocation.findUnique({ where: { organizationId_propertyId: { organizationId: this.organizationId, propertyId } } });
  }
  async metadata(itemKeys: string[], propertyIds: string[]) {
    const [items, locations] = await Promise.all([
      this.tx.inventoryItem.findMany({ where: { organizationId: this.organizationId, key: { in: itemKeys } },
        select: { key: true, category: true, unit: true, archivedAt: true } }),
      this.tx.inventoryLocation.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyIds } },
        select: { propertyId: true, archivedAt: true } })
    ]);
    return { items: new Map(items.map(item => [item.key, item])), locations: new Map(locations.map(location => [location.propertyId, location])) };
  }
  createItem(input: { key: string; category: string; unit: string | null; labels: Prisma.InputJsonValue; sourceConfigRuleId: string }) {
    return this.tx.inventoryItem.create({ data: { ...input, organizationId: this.organizationId } });
  }
  createPropertyLocation(propertyId: string, label: string) {
    return this.tx.inventoryLocation.create({ data: { organizationId: this.organizationId, kind: "PROPERTY", propertyId, label } });
  }

  async position(locationId: string, itemId: string): Promise<StockPosition> {
    const cursors = await this.tx.$queryRaw<Array<{ revision: bigint }>>(Prisma.sql`SELECT revision FROM inventory_stock_cursor
      WHERE organization_id=${this.organizationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid FOR UPDATE`);
    const sum = await this.tx.inventoryMovement.aggregate({ where: { organizationId: this.organizationId, locationId, itemId }, _sum: { quantityDelta: true } });
    return { quantity: sum._sum.quantityDelta?.toFixed(0) ?? "0", revision: cursors[0]?.revision.toString() ?? "0" };
  }

  async record(input: {
    propertyId: string; taskId: string; locationId: string; itemId: string; actorId: string;
    configRuleId: string; expected: StockPosition; countedQuantity: string; delta: string;
    note: string; deviceId: string; clientOpId: string; clientCreatedAt: Date | null;
    configSnapshot: Prisma.InputJsonValue; receivedAt: Date;
  }) {
    const stream = { organizationId: this.organizationId, locationId: input.locationId, itemId: input.itemId };
    const where = { organizationId_locationId_itemId: stream };
    if (!await this.tx.inventoryStockCursor.findUnique({ where })) await this.tx.inventoryStockCursor.create({ data: stream });
    const revision = BigInt(input.expected.revision) + 1n;
    const observation = await this.tx.inventoryStocktake.create({ data: { ...stream, propertyId: input.propertyId, taskId: input.taskId,
      actorId: input.actorId, configRuleId: input.configRuleId, expectedRevision: BigInt(input.expected.revision), revision,
      expectedQuantity: input.expected.quantity, countedQuantity: BigInt(input.countedQuantity), note: input.note,
      deviceId: input.deviceId, clientOpId: input.clientOpId, clientCreatedAt: input.clientCreatedAt,
      configSnapshot: input.configSnapshot, receivedAt: input.receivedAt } });
    const movement = input.delta === "0" ? null : await this.tx.inventoryMovement.create({ data: { ...stream, stocktakeId: observation.id,
      actorId: input.actorId, kind: "STOCKTAKE_ADJUSTMENT", revision, quantityDelta: input.delta, createdAt: input.receivedAt } });
    await this.tx.inventoryStockCursor.update({ where, data: { revision } });
    return { observation, movement, position: { quantity: input.countedQuantity, revision: revision.toString() } };
  }

  async snapshotPositions(streams: Array<{ propertyId: string; itemKey: string }>, at: Date) {
    if (!streams.length) return [];
    const pairs = streams.map(row => ({ property_id: row.propertyId, item_key: row.itemKey }));
    return this.tx.$queryRaw<Array<{ propertyId: string; itemKey: string; quantity: string; revision: string }>>(Prisma.sql`
      SELECT p.property_id::text AS "propertyId",p.item_key AS "itemKey",COALESCE(q.quantity,0)::text AS quantity,
       COALESCE(v.revision,0)::text AS revision
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS p(property_id uuid,item_key text)
      LEFT JOIN inventory_location l ON l.organization_id=${this.organizationId}::uuid AND l.property_id=p.property_id
      LEFT JOIN inventory_item i ON i.organization_id=${this.organizationId}::uuid AND i.key=p.item_key
      LEFT JOIN LATERAL (SELECT sum(quantity_delta) AS quantity FROM inventory_movement m
       WHERE m.organization_id=${this.organizationId}::uuid AND m.location_id=l.id AND m.item_id=i.id AND m.created_at<=${at}) q ON true
      LEFT JOIN LATERAL (SELECT max(revision) AS revision FROM inventory_stocktake s
       WHERE s.organization_id=${this.organizationId}::uuid AND s.location_id=l.id AND s.item_id=i.id AND s.received_at<=${at}) v ON true
      ORDER BY p.property_id,p.item_key`);
  }
}
