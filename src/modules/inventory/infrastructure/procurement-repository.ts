import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {inventoryMinimumsKey} from "@/platform/config/inventory-policy";
import type {InventoryItemHead} from "./inventory-repository";
import type {InventoryMovementPosition} from "../domain/movement";
export class InventoryProcurementRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async policy(propertyId:string|null,at:Date){const scopes=propertyId?await new ReservationConfigScopeRepository(this.tx,this.organizationId).scopes({propertyId,asOf:at}):[{scopeType:"organization",scopeId:null}];return new ConfigRuleRepository(this.tx,this.organizationId).resolve({key:inventoryMinimumsKey,scopes,asOf:at});}
 async streams(locationId:string,keys:readonly string[]){
  if(!keys.length)return[];
  return this.tx.$queryRaw<Array<InventoryItemHead&InventoryMovementPosition>>(Prisma.sql`SELECT i.id,i.key,i.category,i.unit,i.labels,i.source_config_rule_id AS "sourceConfigRuleId",i.created_at AS "createdAt",i.archived_at AS "archivedAt",i.xmin::text,i.ctid::text AS tuple,COALESCE(s.quantity,0)::text AS quantity,COALESCE(s.reserved,0)::text AS reserved,COALESCE(s.damaged,0)::text AS damaged,COALESCE(c.revision,0)::text AS revision FROM inventory_item i LEFT JOIN LATERAL(SELECT sum(m.quantity_delta) AS quantity,sum(m.reserved_quantity_delta) AS reserved,sum(m.damaged_quantity_delta) AS damaged FROM inventory_movement m WHERE m.organization_id=i.organization_id AND m.location_id=${locationId}::uuid AND m.item_id=i.id)s ON true LEFT JOIN inventory_stock_cursor c ON c.organization_id=i.organization_id AND c.location_id=${locationId}::uuid AND c.item_id=i.id WHERE i.organization_id=${this.organizationId}::uuid AND i.key=ANY(${[...keys]}::text[]) ORDER BY i.key`);
 }
}
