import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {InventoryMovementPosition} from "../domain/movement";
import type {InventoryMovementReceipt} from "../domain/movement-command";
import type {Scope} from "@/platform/authz/authorize";
import {inventorySourceSelection} from "./source-scope-sql";
export type InventoryMovementRow={id:string;groupId:string;locationId:string;itemId:string;actorId:string;kind:InventoryMovementReceipt["kind"];quantity:string;reserved:string;damaged:string;revision:string;reservationId:string|null;reversesMovementId:string|null;leg:number;createdAt:Date;sourceSnapshot:unknown;reversedBy:string|null};
export type InventoryMovementReservation={id:string;propertyId:string;status:string;archivedAt:Date|null;xmin:string;tuple:string;city:string|null;region:string|null;propertyArchivedAt:Date|null;propertyXmin:string;propertyTuple:string};
export class InventoryMovementRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async position(locationId:string,itemId:string):Promise<InventoryMovementPosition>{
  const rows=await this.tx.$queryRaw<InventoryMovementPosition[]>(Prisma.sql`SELECT COALESCE((SELECT sum(quantity_delta) FROM inventory_movement WHERE organization_id=${this.organizationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid),0)::text AS quantity,
   COALESCE((SELECT sum(reserved_quantity_delta) FROM inventory_movement WHERE organization_id=${this.organizationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid),0)::text AS reserved,
   COALESCE((SELECT sum(damaged_quantity_delta) FROM inventory_movement WHERE organization_id=${this.organizationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid),0)::text AS damaged,
   COALESCE((SELECT revision FROM inventory_stock_cursor WHERE organization_id=${this.organizationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid),0)::text AS revision`);return rows[0];
 }
 async reservation(id:string):Promise<InventoryMovementReservation|null>{
  const rows=await this.tx.$queryRaw<InventoryMovementReservation[]>(Prisma.sql`SELECT r.id,r.property_id AS "propertyId",r.status::text,r.archived_at AS "archivedAt",r.xmin::text,r.ctid::text AS tuple,COALESCE(p.city_id::text,p.city) AS city,COALESCE(p.region_id::text,p.region) AS region,p.archived_at AS "propertyArchivedAt",p.xmin::text AS "propertyXmin",p.ctid::text AS "propertyTuple" FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id WHERE r.organization_id=${this.organizationId}::uuid AND r.id=${id}::uuid`);return rows[0]??null;
 }
 async reservationLabel(id:string){return(await this.tx.$queryRaw<Array<{reference:string}>>(Prisma.sql`SELECT reference FROM reservation WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid`))[0]?.reference??null;}
 async outstanding(reservationId:string,locationId:string,itemId:string){return(await this.tx.$queryRaw<Array<{quantity:string}>>(Prisma.sql`SELECT COALESCE(sum(reserved_quantity_delta),0)::text AS quantity FROM inventory_movement WHERE organization_id=${this.organizationId}::uuid AND reservation_id=${reservationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid`))[0].quantity;}
 async reservationChoices(input:{query:string;active:boolean;after?:string},heldProperties:readonly Scope[],currentProperties:readonly Scope[],heldReservations:readonly Scope[],currentReservations:readonly Scope[]){
  const pattern="%"+input.query.replace(/[\\%_]/gu,value=>"\\"+value)+"%";
  return this.tx.$queryRaw<Array<{id:string;label:string;version:string}>>(Prisma.sql`SELECT r.id,r.reference||' · '||p.name||' · '||r.check_in::text AS label,r.xmin::text||':'||r.ctid::text||':'||p.xmin::text||':'||p.ctid::text AS version FROM reservation r JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id WHERE r.organization_id=${this.organizationId}::uuid AND p.archived_at IS NULL
   ${input.active?Prisma.sql`AND r.archived_at IS NULL AND r.status NOT IN('CANCELLED','NO_SHOW','CLOSED')`:Prisma.empty}
   AND(r.reference ILIKE ${pattern} OR p.name ILIKE ${pattern}) ${input.after?Prisma.sql`AND r.id>${input.after}::uuid`:Prisma.empty}
   AND ${inventorySourceSelection(heldProperties)} AND ${inventorySourceSelection(currentProperties)} AND ${inventorySourceSelection(heldReservations,true)} AND ${inventorySourceSelection(currentReservations,true)} ORDER BY r.id LIMIT 51`);
 }
 async groups(ids:readonly string[]){
  if(!ids.length)return[];
  return this.tx.$queryRaw<InventoryMovementRow[]>(Prisma.sql`SELECT m.id,m.movement_group_id AS "groupId",m.location_id AS "locationId",m.item_id AS "itemId",m.actor_id AS "actorId",m.kind,m.quantity_delta::text AS quantity,m.reserved_quantity_delta::text AS reserved,m.damaged_quantity_delta::text AS damaged,m.revision::text,m.reservation_id AS "reservationId",m.reverses_movement_id AS "reversesMovementId",m.leg,m.created_at AS "createdAt",m.source_snapshot AS "sourceSnapshot",r.movement_group_id AS "reversedBy" FROM inventory_movement m LEFT JOIN inventory_movement r ON r.organization_id=m.organization_id AND r.reverses_movement_id=m.id WHERE m.organization_id=${this.organizationId}::uuid AND m.movement_group_id IN(${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY m.movement_group_id,m.leg`);
 }
 group(id:string){return this.groups([id]);}
 async page(input:{groupId?:string;locationId?:string;itemId?:string;after?:string},heldProperties:readonly Scope[],currentProperties:readonly Scope[],heldReservations:readonly Scope[],currentReservations:readonly Scope[]){
  return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT m.movement_group_id AS id FROM inventory_movement m WHERE m.organization_id=${this.organizationId}::uuid AND m.leg=1
   ${input.groupId?Prisma.sql`AND m.movement_group_id=${input.groupId}::uuid`:Prisma.empty}
   ${input.locationId?Prisma.sql`AND EXISTS(SELECT 1 FROM inventory_movement leg WHERE leg.organization_id=m.organization_id AND leg.movement_group_id=m.movement_group_id AND leg.location_id=${input.locationId}::uuid)`:Prisma.empty}
   ${input.itemId?Prisma.sql`AND m.item_id=${input.itemId}::uuid`:Prisma.empty}
   ${input.after?Prisma.sql`AND(m.created_at,m.movement_group_id)<(SELECT c.created_at,c.movement_group_id FROM inventory_movement c WHERE c.organization_id=${this.organizationId}::uuid AND c.movement_group_id=${input.after}::uuid AND c.leg=1)`:Prisma.empty}
   AND NOT EXISTS(SELECT 1 FROM inventory_movement leg JOIN inventory_location l ON l.organization_id=leg.organization_id AND l.id=leg.location_id
    LEFT JOIN reservation r ON r.organization_id=leg.organization_id AND r.id=leg.reservation_id LEFT JOIN property p ON p.organization_id=leg.organization_id AND p.id=l.property_id LEFT JOIN property rp ON rp.organization_id=leg.organization_id AND rp.id=r.property_id
    WHERE leg.organization_id=m.organization_id AND leg.movement_group_id=m.movement_group_id
     AND(l.property_id IS NOT NULL AND(p.id IS NULL OR NOT ${inventorySourceSelection(heldProperties)} OR NOT ${inventorySourceSelection(currentProperties)})
      OR leg.reservation_id IS NOT NULL AND(r.id IS NULL OR rp.id IS NULL OR NOT ${inventorySourceSelection(heldProperties,false,"rp")} OR NOT ${inventorySourceSelection(currentProperties,false,"rp")} OR NOT ${inventorySourceSelection(heldReservations,true,"rp")} OR NOT ${inventorySourceSelection(currentReservations,true,"rp")})))
   ORDER BY m.created_at DESC,m.movement_group_id DESC LIMIT 51`);
 }
 async record(input:{groupId:string;actorId:string;kind:InventoryMovementReceipt["kind"];lines:InventoryMovementReceipt["lines"];sources:readonly unknown[];at:Date}){
  for(const [index,line]of input.lines.entries()){
   await this.tx.$executeRaw(Prisma.sql`INSERT INTO inventory_stock_cursor(organization_id,location_id,item_id,revision) VALUES(${this.organizationId}::uuid,${line.locationId}::uuid,${line.itemId}::uuid,0) ON CONFLICT DO NOTHING`);
   await this.tx.$executeRaw(Prisma.sql`INSERT INTO inventory_movement(id,organization_id,location_id,item_id,actor_id,kind,quantity_delta,reserved_quantity_delta,damaged_quantity_delta,revision,movement_group_id,leg,reservation_id,reverses_movement_id,source_snapshot,created_at)
    VALUES(${line.id}::uuid,${this.organizationId}::uuid,${line.locationId}::uuid,${line.itemId}::uuid,${input.actorId}::uuid,${input.kind},${line.quantity}::numeric,${line.reserved}::numeric,${line.damaged}::numeric,${line.revision}::bigint,${input.groupId}::uuid,${line.leg}::smallint,${line.reservationId}::uuid,${line.reversesMovementId}::uuid,${JSON.stringify(input.sources[index])}::jsonb,${input.at})`);
   await this.tx.$executeRaw(Prisma.sql`UPDATE inventory_stock_cursor SET revision=${line.revision}::bigint WHERE organization_id=${this.organizationId}::uuid AND location_id=${line.locationId}::uuid AND item_id=${line.itemId}::uuid`);
  }
 }
}
