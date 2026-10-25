import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { inventoryMinimumsKey, inventoryMinimumsSchema } from "@/platform/config/inventory-policy";
import { fieldLinenSnapshotSchema, type FieldLinenSnapshot } from "./field-stocktake";
import { InventoryRepository } from "@/modules/inventory/infrastructure/inventory-repository";

/** Caller supplies only currently authorized task properties, once per pull page. */
export async function fieldLinenSnapshots(tx: TenantTransaction, organizationId: string, propertyIds: string[], asOf: Date) {
  const ids = [...new Set(propertyIds)];
  const scopes = await new ReservationConfigScopeRepository(tx, organizationId).propertyScopes(ids, asOf);
  const rules = await new ConfigRuleRepository(tx, organizationId).resolveScopeGroups(inventoryMinimumsKey, scopes, asOf, { recordedAt: asOf });
  const catalogs = new Map(ids.map(id => { const rule = rules.get(id); return [id, rule ? inventoryMinimumsSchema.parse(rule.parsedValue).minimums
    .filter(item => item.category === "LINEN") : []] as const; }));
  const streams = [...catalogs].flatMap(([propertyId, items]) => items.map(item => ({ propertyId, itemKey: item.item })));
  const repository = new InventoryRepository(tx, organizationId), keys = [...new Set(streams.map(stream => stream.itemKey))];
  const [positions, metadata] = await Promise.all([repository.snapshotPositions(streams, asOf), repository.metadata(keys, ids)]);
  const byStream = new Map(positions.map(position => [`${position.propertyId}:${position.itemKey}`, position]));
  return new Map(ids.map(id => {
    const rule = rules.get(id), location = metadata.locations.get(id);
    const snapshot: FieldLinenSnapshot = { catalog: rule ? { id: rule.id, version: rule.version } : null,
      items: (catalogs.get(id) ?? []).map(configured => {
        const item = metadata.items.get(configured.item), position = byStream.get(`${id}:${configured.item}`);
        return { key: configured.item, name: configured.name ?? { en: configured.item, fr: configured.item }, unit: configured.unit ?? null,
          quantity: position?.quantity ?? "0", revision: position?.revision ?? "0",
          available: !location?.archivedAt && (!item || (!item.archivedAt && item.category === "LINEN" && item.unit === (configured.unit ?? null))) };
      }) };
    return [id, fieldLinenSnapshotSchema.parse(snapshot)] as const;
  }));
}
