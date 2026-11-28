import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {Scope} from "@/platform/authz/authorize";
import type {inventoryCountSelectionSchema} from "../domain/stocktake-command";
import type {z} from "zod";
import {inventorySourceSelection} from "./source-scope-sql";
export class InventoryStocktakeRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 byId(id:string){return this.tx.inventoryStocktake.findFirst({where:{organizationId:this.organizationId,id},include:{movement:true}});}
 async page(input:z.infer<typeof inventoryCountSelectionSchema>,held:readonly Scope[],current:readonly Scope[]){
  return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT s.id FROM inventory_stocktake s JOIN inventory_location l ON l.organization_id=s.organization_id AND l.id=s.location_id LEFT JOIN property p ON p.organization_id=l.organization_id AND p.id=l.property_id WHERE s.organization_id=${this.organizationId}::uuid
   ${input.locationId?Prisma.sql`AND s.location_id=${input.locationId}::uuid`:Prisma.empty}
   ${input.itemId?Prisma.sql`AND s.item_id=${input.itemId}::uuid`:Prisma.empty}
   ${input.varianceOnly?Prisma.sql`AND s.counted_quantity<>s.expected_quantity`:Prisma.empty}
   ${input.after?Prisma.sql`AND(s.received_at,s.id)<(SELECT c.received_at,c.id FROM inventory_stocktake c JOIN inventory_location cl ON cl.organization_id=c.organization_id AND cl.id=c.location_id LEFT JOIN property p ON p.organization_id=cl.organization_id AND p.id=cl.property_id WHERE c.organization_id=${this.organizationId}::uuid AND c.id=${input.after}::uuid
    ${input.locationId?Prisma.sql`AND c.location_id=${input.locationId}::uuid`:Prisma.empty}${input.itemId?Prisma.sql`AND c.item_id=${input.itemId}::uuid`:Prisma.empty}${input.varianceOnly?Prisma.sql`AND c.counted_quantity<>c.expected_quantity`:Prisma.empty}
    AND(cl.property_id IS NULL OR(p.id IS NOT NULL AND ${inventorySourceSelection(held)} AND ${inventorySourceSelection(current)})))`:Prisma.empty}
   AND(l.property_id IS NULL OR(p.id IS NOT NULL AND ${inventorySourceSelection(held)} AND ${inventorySourceSelection(current)})) ORDER BY s.received_at DESC,s.id DESC LIMIT 51`);
 }
}
