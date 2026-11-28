import type {TenantTransaction} from "@/platform/db/tenant";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {InventoryReorderRepository} from "@/modules/inventory/infrastructure/reorder-repository";
import {inventoryMinimumsForLocation,inventoryReorderRecommendation} from "@/modules/inventory/domain/reorder";
import {inventoryReorderSignalSchema,inventoryReorderSignalKey} from "@/modules/inventory/domain/reorder-event";
import {configuredInventoryItem} from "@/modules/inventory/domain/item-definition";
/** Signals extend the native outbox and configured automation engine. They
 * never create orders, move cash, recognize expenses or change stock balances. */
export async function appendInventoryReorderSignal(tx:TenantTransaction,actor:{organizationId:string;actorId:string},input:{locationId:string;itemId:string;revision:string;source:{kind:"MOVEMENT"|"STOCKTAKE"|"CONFIGURATION";id:string}},at:Date){
 const repository=new InventoryReorderRepository(tx,actor.organizationId),snapshot=await repository.snapshot(input.locationId,input.itemId,at);if(!snapshot?.rule||snapshot.location.archivedAt||snapshot.location.propertyArchivedAt||snapshot.item.archivedAt)return null;
 const minimum=inventoryMinimumsForLocation(snapshot.rule.parsedValue,input.locationId).find(value=>value.item===snapshot.item.key);if(!minimum)return null;
 const definition=configuredInventoryItem(minimum,snapshot.item);if(!definition||definition.category!==snapshot.item.category||definition.unit!==snapshot.item.unit)return null;
 const recommendation=inventoryReorderRecommendation(minimum,snapshot.position);if(!recommendation.belowMinimum)return null;
 const original=await repository.originalSource({...input.source,locationId:input.locationId,itemId:input.itemId,revision:input.revision});if(!original||original.actorId!==actor.actorId||snapshot.position.revision!==input.revision)throw Error("inventory_reorder_original_source_required");
 const signal=inventoryReorderSignalSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,item:{id:snapshot.item.id,key:snapshot.item.key,category:snapshot.item.category,unit:snapshot.item.unit},location:{id:snapshot.location.id,kind:snapshot.location.kind,propertyId:snapshot.location.propertyId},source:input.source,position:snapshot.position,minimumRule:{id:snapshot.rule.id,version:snapshot.rule.version},basis:recommendation.basis,minimum:recommendation.minimum,target:recommendation.target,current:recommendation.current,suggestedQuantity:recommendation.suggestedQuantity,timezone:snapshot.timezone});
 const payload={...signal.location.propertyId?{propertyId:signal.location.propertyId}:{},inventory:{item:signal.item.key,quantity:signal.current},inventorySource:signal};return new OutboxRepository(tx,actor.organizationId).append("InventoryBelowMinimum",payload,inventoryReorderSignalKey(signal),at);
}
