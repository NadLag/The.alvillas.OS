import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {inventoryMovementReadAuthorityInTransaction} from "./movement-service";
import {InventoryReorderRepository} from "../infrastructure/reorder-repository";
import type {InventoryReorderSignal} from "../domain/reorder-event";
import {inventoryMinimumsForLocation,inventoryReorderRecommendation} from "../domain/reorder";
import {configuredInventoryItem} from "../domain/item-definition";
import {InventoryCatalogAccessError} from "../domain/catalog-errors";

/** Native operational sources are checked independently of automation access.
 * Staleness suppresses an effect; it never extends a caller's source rights. */
export async function inventoryReorderAuthorityInTransaction(actor:AccountActorContext,tx:TenantTransaction,signal:InventoryReorderSignal){
 const context=await inventoryMovementReadAuthorityInTransaction(actor,tx),repository=new InventoryReorderRepository(tx,actor.organizationId);
 const [item,location,original]=await Promise.all([context.inventory.catalogItemById(signal.item.id),context.inventory.locationCatalogById(signal.location.id),repository.originalSource({...signal.source,locationId:signal.location.id,itemId:signal.item.id,revision:signal.position.revision})]);
 if(signal.organizationId!==actor.organizationId||!item||!location||!original||original.actorId!==signal.actorId||item.key!==signal.item.key||item.category!==signal.item.category||item.unit!==signal.item.unit||location.kind!==signal.location.kind||location.propertyId!==signal.location.propertyId)throw new InventoryCatalogAccessError();
 const source={organizationId:actor.organizationId,propertyId:location.propertyId,city:location.propertyCity,region:location.propertyRegion,dataClass:"operational"as const},checks:CurrentAuthorityCheck[]=[...context.checks,{action:"view",resource:{...source,type:"config_rule",id:signal.minimumRule.id},...location.propertyId?{unconditional:true}:{organizationOnly:true}}];
 if(location.propertyId)checks.push({action:"view",unconditional:true,resource:{...source,type:"property",id:location.propertyId}});
 assertAccountAuthorization(actor,context.stored,context.now,checks,new InventoryCatalogAccessError());
 const snapshot=await repository.snapshot(location.id,item.id,context.now),minimum=snapshot?inventoryMinimumsForLocation(snapshot.rule.parsedValue,location.id).find(value=>value.item===item.key):undefined,definition=minimum?configuredInventoryItem(minimum,item):null,recommendation=minimum&&snapshot?inventoryReorderRecommendation(minimum,snapshot.position):null;
 const fresh=Boolean(snapshot&&minimum&&definition&&definition.category===item.category&&definition.unit===item.unit&&!item.archivedAt&&!location.archivedAt&&!location.propertyArchivedAt&&snapshot.rule.id===signal.minimumRule.id&&snapshot.rule.version===signal.minimumRule.version&&snapshot.timezone===signal.timezone&&jsonbFingerprint(snapshot.position)===jsonbFingerprint(signal.position)&&recommendation?.belowMinimum&&recommendation.basis===signal.basis&&recommendation.minimum===signal.minimum&&recommendation.target===signal.target&&recommendation.current===signal.current&&recommendation.suggestedQuantity===signal.suggestedQuantity);
 await recheckAccountAuthorization(actor,tx,await context.inventory.catalogClock(),checks,new InventoryCatalogAccessError());
 return{...context,checks,item,location,snapshot,fresh,witness:jsonbFingerprint({cap:context.cap,item,location,original,position:snapshot?.position,rule:snapshot?.rule.id,version:snapshot?.rule.version,timezone:snapshot?.timezone,fresh})};
}
export async function lockInventoryReorderSourceInTransaction(actor:AccountActorContext,tx:TenantTransaction,signal:InventoryReorderSignal){
 const before=await inventoryReorderAuthorityInTransaction(actor,tx,signal);await before.inventory.lockMovementStreams(before.item,[before.location]);return inventoryReorderAuthorityInTransaction(actor,tx,signal);
}
