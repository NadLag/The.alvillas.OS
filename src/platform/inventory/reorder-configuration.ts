import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {inventoryMinimumsKey} from "@/platform/config/inventory-policy";
import {inventoryReorderConfigurationReferenceSchema,inventoryReorderConfigurationRequested,inventoryReorderConfigurationKey} from "@/platform/config/inventory-reorder-reference";
import {InventoryReorderRepository} from "@/modules/inventory/infrastructure/reorder-repository";
import {InventoryRepository} from "@/modules/inventory/infrastructure/inventory-repository";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {appendInventoryReorderSignal} from "./reorder-events";

/** Bounded continuation of the existing native configuration/outbox pipeline.
 * Effects still require an independently authorized configured automation. */
export async function consumeInventoryReorderConfiguration(organizationId:string,eventId:string,deps:{db?:TenantTransactionRunner;now?:Date}={}){
 return withTenant(deps.db??prisma,organizationId,async tx=>{
  const outbox=new OutboxRepository(tx,organizationId),event=await outbox.event(eventId);if(!event||event.type!==inventoryReorderConfigurationRequested)throw Error("inventory_reorder_configuration_source_missing");
  const reference=inventoryReorderConfigurationReferenceSchema.parse(event.payload),configuration=new ConfigRuleRepository(tx,organizationId),cause=await configuration.findById(reference.configRuleId),inventory=new InventoryRepository(tx,organizationId),now=deps.now??await inventory.catalogClock();
  if(!cause||cause.key!==inventoryMinimumsKey||cause.lifecycle==="DRAFT"||!cause.createdBy||event.idempotencyKey!==inventoryReorderConfigurationKey(reference))throw Error("inventory_reorder_configuration_source_missing");
  const due=reference.phase==="START"?cause.effectiveFrom:cause.effectiveTo;if(!due||due>now)throw Error("inventory_reorder_configuration_not_due");
  const repository=new InventoryReorderRepository(tx,organizationId),targets=await repository.configurationTargets(cause,now,reference.after),page=targets.slice(0,50),snapshots=await Promise.all(page.map(target=>repository.snapshot(target.locationId,target.itemId,now)));
  const scopes=new Map(snapshots.flatMap(snapshot=>snapshot?.scopes??[]).map(scope=>[scope.scopeType+":"+(scope.scopeId??""),scope]));for(const [,scope]of[...scopes].sort(([a],[b])=>a.localeCompare(b)))await configuration.lockVersion(inventoryMinimumsKey,scope.scopeType,scope.scopeId);
  const items=new Map(snapshots.flatMap(snapshot=>snapshot?[ [snapshot.item.id,snapshot.item]as const ]:[]));for(const item of[...items.values()].sort((a,b)=>a.key.localeCompare(b.key))){const locations=snapshots.filter(snapshot=>snapshot?.item.id===item.id).flatMap(snapshot=>snapshot?[snapshot.location]:[]);await inventory.lockMovementStreams(item,locations);}
  let signals=0;const at=deps.now??await inventory.catalogClock();
  for(const target of page){const current=await repository.snapshot(target.locationId,target.itemId,at);if(!current)continue;if(await appendInventoryReorderSignal(tx,{organizationId,actorId:cause.createdBy},{...target,revision:current.position.revision,source:{kind:"CONFIGURATION",id:cause.id}},at))signals++;}
  if(targets.length>50){const continuation={schemaVersion:1,configRuleId:cause.id,phase:reference.phase,after:page[49]}as const;await outbox.append(inventoryReorderConfigurationRequested,continuation,inventoryReorderConfigurationKey(continuation),event.occurredAt);}
  return{examined:page.length,signals,continued:targets.length>50};
 });
}
