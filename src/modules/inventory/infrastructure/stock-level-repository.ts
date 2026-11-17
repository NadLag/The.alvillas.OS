import {Prisma} from "@prisma/client";
import type {Scope} from "@/platform/authz/authorize";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {InventoryStockSelection} from "../domain/stock-levels";
import {inventorySourceSelection} from "./source-scope-sql";
export type InventoryStockRow={itemId:string;key:string;category:string;unit:string|null;labels:unknown;itemArchivedAt:Date|null;itemXmin:string;itemTuple:string;locationId:string;kind:string;label:string;propertyId:string|null;propertyName:string|null;locationArchivedAt:Date|null;locationXmin:string;locationTuple:string;propertyArchivedAt:Date|null;propertyXmin:string|null;propertyTuple:string|null;quantity:string;reserved:string;damaged:string;revision:string;lastMovementAt:Date|null;lastCountAt:Date|null};
export type InventoryStockTotals={quantity:string;reserved:string;damaged:string;available:string;shortage:string;conditionShortage:string;locationCount:string};
export class InventoryStockLevelRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 private eligible(input:InventoryStockSelection,held:readonly Scope[],current:readonly Scope[],cursor:boolean){
  const pattern="%"+input.query.replace(/[\\%_]/gu,value=>"\\"+value)+"%";
  return Prisma.sql`i.organization_id=${this.organizationId}::uuid AND(l.property_id IS NULL OR(p.id IS NOT NULL AND ${inventorySourceSelection(held)} AND ${inventorySourceSelection(current)}))
   ${input.mode==="LOCATION"?Prisma.sql`AND l.id=${input.locationId}::uuid AND(${input.includeRetired}::boolean OR i.archived_at IS NULL)
    AND(i.key ILIKE ${pattern} OR i.unit ILIKE ${pattern} OR i.labels->>'en' ILIKE ${pattern} OR i.labels->>'fr' ILIKE ${pattern} OR i.labels->>'ar' ILIKE ${pattern})
    ${input.category?Prisma.sql`AND i.category=${input.category}`:Prisma.empty} ${cursor&&input.after?Prisma.sql`AND i.key>${input.after}`:Prisma.empty}`:
   Prisma.sql`AND i.id=${input.itemId}::uuid AND(${input.includeRetired}::boolean OR(l.archived_at IS NULL AND p.archived_at IS NULL))
    AND(l.label ILIKE ${pattern} OR p.name ILIKE ${pattern}) ${input.kind?Prisma.sql`AND l.kind=${input.kind}`:Prisma.empty} ${cursor&&input.after?Prisma.sql`AND l.id>${input.after}::uuid`:Prisma.empty}`}`;
 }
 private positions(){return Prisma.sql`LEFT JOIN LATERAL(SELECT COALESCE(sum(m.quantity_delta),0) AS quantity,COALESCE(sum(m.reserved_quantity_delta),0) AS reserved,COALESCE(sum(m.damaged_quantity_delta),0) AS damaged,max(m.created_at) AS last_movement_at FROM inventory_movement m WHERE m.organization_id=${this.organizationId}::uuid AND m.location_id=base.location_id AND m.item_id=base.item_id) stock ON true
  LEFT JOIN inventory_stock_cursor c ON c.organization_id=${this.organizationId}::uuid AND c.location_id=base.location_id AND c.item_id=base.item_id
  LEFT JOIN LATERAL(SELECT max(received_at) AS last_count_at FROM inventory_stocktake s WHERE s.organization_id=${this.organizationId}::uuid AND s.location_id=base.location_id AND s.item_id=base.item_id) counts ON true`;}
 page(input:InventoryStockSelection,held:readonly Scope[],current:readonly Scope[]){
  return this.tx.$queryRaw<InventoryStockRow[]>(Prisma.sql`WITH base AS(SELECT i.id AS item_id,i.key,i.category,i.unit,i.labels,i.archived_at AS item_archived_at,i.xmin::text AS item_xmin,i.ctid::text AS item_tuple,l.id AS location_id,l.kind,l.label,l.property_id,l.archived_at AS location_archived_at,l.xmin::text AS location_xmin,l.ctid::text AS location_tuple,p.name AS property_name,p.archived_at AS property_archived_at,p.xmin::text AS property_xmin,p.ctid::text AS property_tuple
   FROM inventory_item i JOIN inventory_location l ON l.organization_id=i.organization_id LEFT JOIN property p ON p.organization_id=l.organization_id AND p.id=l.property_id WHERE ${this.eligible(input,held,current,true)} ORDER BY ${input.mode==="LOCATION"?Prisma.sql`i.key`:Prisma.sql`l.id`} LIMIT 51)
   SELECT base.item_id AS "itemId",base.key,base.category,base.unit,base.labels,base.item_archived_at AS "itemArchivedAt",base.item_xmin AS "itemXmin",base.item_tuple AS "itemTuple",base.location_id AS "locationId",base.kind,base.label,base.property_id AS "propertyId",base.property_name AS "propertyName",base.location_archived_at AS "locationArchivedAt",base.location_xmin AS "locationXmin",base.location_tuple AS "locationTuple",base.property_archived_at AS "propertyArchivedAt",base.property_xmin AS "propertyXmin",base.property_tuple AS "propertyTuple",stock.quantity::text,stock.reserved::text,stock.damaged::text,COALESCE(c.revision,0)::text AS revision,stock.last_movement_at AS "lastMovementAt",counts.last_count_at AS "lastCountAt"
   FROM base ${this.positions()} ORDER BY ${input.mode==="LOCATION"?Prisma.sql`base.key`:Prisma.sql`base.location_id`}`);
 }
 async totals(input:InventoryStockSelection,held:readonly Scope[],current:readonly Scope[]):Promise<InventoryStockTotals|null>{
  if(input.mode!=="ITEM")return null;
  const rows=await this.tx.$queryRaw<InventoryStockTotals[]>(Prisma.sql`WITH base AS(SELECT i.id AS item_id,l.id AS location_id FROM inventory_item i JOIN inventory_location l ON l.organization_id=i.organization_id LEFT JOIN property p ON p.organization_id=l.organization_id AND p.id=l.property_id WHERE ${this.eligible(input,held,current,false)})
   SELECT COALESCE(sum(stock.quantity),0)::text AS quantity,COALESCE(sum(stock.reserved),0)::text AS reserved,COALESCE(sum(stock.damaged),0)::text AS damaged,COALESCE(sum(stock.quantity-stock.reserved-stock.damaged),0)::text AS available,COALESCE(sum(GREATEST(0,stock.reserved+stock.damaged-stock.quantity)),0)::text AS shortage,COALESCE(sum(GREATEST(0,stock.damaged-stock.quantity)),0)::text AS "conditionShortage",count(*)::text AS "locationCount" FROM base ${this.positions()}`);return rows[0];
 }
}
