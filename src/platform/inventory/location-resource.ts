import type {Resource} from "@/platform/authz/authorize";
import type {TenantTransaction} from "@/platform/db/tenant";
import {InventoryRepository} from "@/modules/inventory/infrastructure/inventory-repository";
/** Native cross-module source projection. Private labels stay in their
 * original audit, while current property scope and physical versions fence it. */
export async function nativeInventoryLocationResources(tx:TenantTransaction,organizationId:string,ids:string[]):Promise<Map<string,Resource&{sourceRecordId:string}>>{
 const rows=await new InventoryRepository(tx,organizationId).locationCatalogAuditSources(ids);
 return new Map(rows.map(row=>[row.id,{type:"inventory_location",organizationId,id:row.id,propertyId:row.propertyId??undefined,city:row.propertyCity??undefined,region:row.propertyRegion??undefined,dataClass:"operational",sourceRecordId:[row.xmin,row.tuple,row.propertyXmin,row.propertyTuple].join(":")}]));
}
