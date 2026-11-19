import type {Resource} from "@/platform/authz/authorize";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {InventoryRepository} from "@/modules/inventory/infrastructure/inventory-repository";
import {InventoryMovementRepository} from "@/modules/inventory/infrastructure/movement-repository";
export async function nativeInventoryMovementResources(tx:TenantTransaction,organizationId:string,ids:string[]):Promise<Map<string,Resource&{sourceRecordId:string;inventorySources:Resource[]}>>{
 const inventory=new InventoryRepository(tx,organizationId),movements=new InventoryMovementRepository(tx,organizationId),rows=await movements.groups(ids),result=new Map<string,Resource&{sourceRecordId:string;inventorySources:Resource[]}>();
 for(const id of ids){
  const lines=rows.filter(row=>row.groupId===id);if(!lines.length)continue;
  const item=await inventory.catalogItemById(lines[0].itemId),locations=await Promise.all(lines.map(row=>inventory.locationCatalogById(row.locationId))),reservations=await Promise.all([...new Set(lines.flatMap(row=>row.reservationId?[row.reservationId]:[]))].map(reservationId=>movements.reservation(reservationId)));
  if(!item||locations.some(row=>!row)||reservations.some(row=>!row))continue;
  const inventorySources:Resource[]=[];let missing=false;
  for(const row of locations)if(row?.propertyId){if(!row.propertyXmin||!row.propertyTuple){missing=true;break;}inventorySources.push({type:"property",organizationId,id:row.propertyId,propertyId:row.propertyId,city:row.propertyCity,region:row.propertyRegion,dataClass:"operational"});}
  if(missing)continue;
  for(const row of reservations)if(row)inventorySources.push({type:"reservation",organizationId,id:row.id,reservationId:row.id,propertyId:row.propertyId,city:row.city,region:row.region,status:row.status,dataClass:"operational"},{type:"property",organizationId,id:row.propertyId,propertyId:row.propertyId,city:row.city,region:row.region,dataClass:"operational"});
  result.set(id,{type:"inventory_movement",organizationId,id,dataClass:"operational",inventorySources,sourceRecordId:jsonbFingerprint({item,locations,reservations,lines})});
 }
 return result;
}
