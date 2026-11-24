import type {Resource} from "@/platform/authz/authorize";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {inventoryReorderSignalSchema} from "@/modules/inventory/domain/reorder-event";
import {InventoryReorderRepository} from "@/modules/inventory/infrastructure/reorder-repository";
import {InventoryRepository} from "@/modules/inventory/infrastructure/inventory-repository";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {inventoryReorderConfigChecks} from "./reorder-config-authority";
import {z} from "zod";
import {nativeInventoryCountEventSource} from "./stocktake-event-source";
type InventoryAuditResource=Resource&{sourceRecordId:string;inventorySources:Resource[]};
async function originalSignal(tx:TenantTransaction,organizationId:string,raw:unknown){
 const parsed=inventoryReorderSignalSchema.safeParse(raw);if(!parsed.success)return null;const signal=parsed.data,repository=new InventoryReorderRepository(tx,organizationId),inventory=new InventoryRepository(tx,organizationId);
 const [item,location,original]=await Promise.all([inventory.catalogItemById(signal.item.id),inventory.locationCatalogById(signal.location.id),repository.originalSource({...signal.source,locationId:signal.location.id,itemId:signal.item.id,revision:signal.position.revision})]);
 if(!item||!location||!original||signal.organizationId!==organizationId||original.actorId!==signal.actorId||signal.location.propertyId!==location.propertyId||signal.item.key!==item.key||signal.item.unit!==item.unit||signal.item.category!==item.category)return null;
 const source={organizationId,propertyId:location.propertyId,city:location.propertyCity,region:location.propertyRegion,dataClass:"operational"as const},inventorySources:Resource[]=[{...source,type:"config_rule",id:signal.minimumRule.id}];
 if(location.propertyId){if(!location.propertyXmin||!location.propertyTuple)return null;inventorySources.push({...source,type:"property",id:location.propertyId});}
 return{signal,item,location,original,source,inventorySources,property:location.propertyId?{id:location.propertyId,cityId:location.propertyCity,regionId:location.propertyRegion}:null};
}
export async function nativeInventoryReorderResources(tx:TenantTransaction,organizationId:string,ids:string[]):Promise<Map<string,Resource&{sourceRecordId:string;inventorySources:Resource[]}>>{
 const repository=new InventoryReorderRepository(tx,organizationId),result=new Map<string,InventoryAuditResource>();
 for(const row of await repository.suggestionsByIds(ids)){
  const original=await originalSignal(tx,organizationId,row.nativeSource.signal);if(!original||!row.automation)continue;
  const checks=inventoryReorderConfigChecks(organizationId,original.property,row.automation.configs,row.automation.rule);
  result.set(row.id,{type:"inventory_reorder",id:row.id,organizationId,dataClass:"operational",inventorySources:[...original.inventorySources,...checks.map(check=>check.resource)],sourceRecordId:jsonbFingerprint({row,original})});
 }
 return result;
}
export async function nativeInventoryAutomationAuditResources(tx:TenantTransaction,organizationId:string,ids:string[]):Promise<Map<string,InventoryAuditResource>>{
 const repository=new InventoryReorderRepository(tx,organizationId),result=new Map<string,InventoryAuditResource>();
 for(const row of await repository.automationAuditSources(ids)){
  const parsed=z.object({inventorySource:z.object({eventId:z.uuid(),configRuleId:z.uuid()}).strict()}).passthrough().safeParse(row.after);if(!parsed.success)continue;
  const [event,rule]=await Promise.all([new OutboxRepository(tx,organizationId).event(parsed.data.inventorySource.eventId),new ConfigRuleRepository(tx,organizationId).findById(parsed.data.inventorySource.configRuleId)]);
  if(!event||!rule||!rule.key.startsWith("automation.rule."))continue;
  if(event.type==="StocktakeVariance"){
   const original=await nativeInventoryCountEventSource(tx,organizationId,event);if(!original||row.propertyScopeId!==original.propertyId)continue;const source=original.resources.find(resource=>resource.type==="property"),property=original.propertyId?{id:original.propertyId,cityId:source&&"city"in source?source.city??null:null,regionId:source&&"region"in source?source.region??null:null}:null,checks=inventoryReorderConfigChecks(organizationId,property,{},rule.value);
   result.set(row.id,{type:"automation",id:row.id,organizationId,dataClass:"operational",inventorySources:[...original.resources,{type:"config_rule",organizationId,id:rule.id,propertyId:original.propertyId,dataClass:"operational"},...checks.map(check=>check.resource)],sourceRecordId:jsonbFingerprint({row,original,event:{id:event.id,type:event.type,organizationId:event.organizationId,payload:event.payload,idempotencyKey:event.idempotencyKey,occurredAt:event.occurredAt},rule})});continue;
  }
  if(event.type!=="InventoryBelowMinimum")continue;
  const original=await originalSignal(tx,organizationId,(event.payload as Record<string,unknown>).inventorySource);if(!original||row.propertyScopeId!==original.signal.location.propertyId)continue;
  const checks=inventoryReorderConfigChecks(organizationId,original.property,{},rule.value);
  result.set(row.id,{type:"automation",id:row.id,organizationId,dataClass:"operational",inventorySources:[...original.inventorySources,{...original.source,type:"config_rule",id:rule.id},...checks.map(check=>check.resource)],sourceRecordId:jsonbFingerprint({row,original,event:{id:event.id,type:event.type,organizationId:event.organizationId,payload:event.payload,idempotencyKey:event.idempotencyKey,occurredAt:event.occurredAt},rule})});
 }
 return result;
}
