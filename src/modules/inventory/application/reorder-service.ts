import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {inventoryMovementReadAuthorityInTransaction} from "./movement-service";
import {inventoryStockPage} from "./stock-level-service";
import {InventoryReorderRepository} from "../infrastructure/reorder-repository";
import {inventoryMinimumsForLocation,inventoryReorderRecommendation} from "../domain/reorder";
import {inventoryReorderSignalSchema} from "../domain/reorder-event";
import {configuredInventoryItem} from "../domain/item-definition";
import {inventoryStockSelectionSchema,type InventoryStockSelection} from "../domain/stock-levels";
import {inventoryReorderPageSchema} from "../domain/reorder-view";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "../domain/catalog-errors";
import {inventoryReorderConfigChecks} from "@/platform/inventory/reorder-config-authority";
const minimumCheck=(organizationId:string):CurrentAuthorityCheck=>({action:"view",organizationOnly:true,resource:{type:"config_rule",organizationId,dataClass:"operational"}});
async function authority(actor:AccountActorContext,tx:TenantTransaction){const context=await inventoryMovementReadAuthorityInTransaction(actor,tx);await recheckAccountAuthorization(actor,tx,context.now,[minimumCheck(actor.organizationId)],new InventoryCatalogAccessError());return context;}
export async function assertInventoryReorderViewer(actor:AccountActorContext,deps:{db?:TenantTransactionRunner}={}){return withTenant(deps.db??prisma,actor.organizationId,async tx=>{await authority(actor,tx);});}
async function prepare(actor:AccountActorContext,tx:TenantTransaction,input:InventoryStockSelection){
 const context=await authority(actor,tx),stock=await inventoryStockPage(actor,input,{db:{$transaction:async work=>work(tx)}}),repository=new InventoryReorderRepository(tx,actor.organizationId),items=[],checks=[...context.checks,minimumCheck(actor.organizationId)],heads=[];
 const propertyCheck=(location:{propertyId:string|null;propertyCity:string|null;propertyRegion:string|null})=>{if(location.propertyId)checks.push({action:"view",unconditional:true,resource:{type:"property",id:location.propertyId,propertyId:location.propertyId,city:location.propertyCity,region:location.propertyRegion,organizationId:actor.organizationId,dataClass:"operational"}});};
 if(input.mode==="LOCATION"){const head=await context.inventory.locationCatalogById(input.locationId);if(!head)throw new InventoryCatalogAccessError();propertyCheck(head);heads.push(head);}
 for(const row of stock.items){
  const snapshot=await repository.snapshot(row.location.id,row.item.id,context.now),position={quantity:row.position.quantity,reserved:row.position.reserved,damaged:row.position.damaged,revision:row.position.revision};
  if(snapshot){propertyCheck(snapshot.location);heads.push({item:snapshot.item,location:snapshot.location});}
  else{const location=await context.inventory.locationCatalogById(row.location.id);if(!location)throw new InventoryCatalogAccessError();propertyCheck(location);heads.push(location);}
  if(snapshot&&jsonbFingerprint(snapshot.position)!==jsonbFingerprint(position))throw new InventoryCatalogConflictError();
  const configured=snapshot?inventoryMinimumsForLocation(snapshot.rule.parsedValue,row.location.id).find(value=>value.item===row.item.key):undefined,definition=configured&&snapshot?configuredInventoryItem(configured,snapshot.item):null,recommendation=configured&&definition&&definition.category===row.item.category&&definition.unit===row.item.unit&&!row.item.retired&&!row.location.retired?inventoryReorderRecommendation(configured,position):null;
  const minimum=recommendation&&snapshot?{...recommendation,ruleId:snapshot.rule.id,version:snapshot.rule.version}:null,latest=minimum?.belowMinimum&&snapshot?await repository.latestSuggestion(row.location.id,row.item.id,position,snapshot.rule.id):null;
  let latestSuggestion=null;if(latest&&latest.automation&&snapshot){const signal=inventoryReorderSignalSchema.parse(latest.nativeSource.signal);if(signal.item.id!==row.item.id||signal.location.id!==row.location.id||signal.suggestedQuantity!==minimum?.suggestedQuantity)throw new InventoryCatalogAccessError();const financial=inventoryReorderConfigChecks(actor.organizationId,snapshot.location.propertyId?{id:snapshot.location.propertyId,cityId:snapshot.location.propertyCity,regionId:snapshot.location.propertyRegion}:null,latest.automation.configs,latest.automation.rule);try{await recheckAccountAuthorization(actor,tx,context.now,financial,new InventoryCatalogAccessError());latestSuggestion={id:latest.id,title:latest.title,quantity:signal.suggestedQuantity,createdAt:latest.createdAt.toISOString()};checks.push(...financial);}catch(error){if(!(error instanceof InventoryCatalogAccessError))throw error;}}
  items.push({...row,minimum:minimum?{ruleId:minimum.ruleId,version:minimum.version,basis:minimum.basis,minimum:minimum.minimum,target:minimum.target,current:minimum.current,suggestedQuantity:minimum.suggestedQuantity,belowMinimum:minimum.belowMinimum}:null,latestSuggestion});
 }
 const value=inventoryReorderPageSchema.parse({...stock,items});return{...context,checks,value,witness:jsonbFingerprint({cap:context.cap,heads,value:{...value,observedAt:null}})};
}
export async function inventoryReorderPage(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner}={}){const input=inventoryStockSelectionSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
 const before=await prepare(actor,tx,input),after=await prepare(actor,tx,input);if(before.witness!==after.witness)throw new InventoryCatalogConflictError();await recheckAccountAuthorization(actor,tx,await after.inventory.catalogClock(),[...after.checks,minimumCheck(actor.organizationId)],new InventoryCatalogAccessError());
 return inventoryReorderPageSchema.parse(present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{type:"inventory_movement",organizationId:actor.organizationId,data:after.value},Object.fromEntries(Object.keys(after.value).map(key=>[key,{dataClass:"operational"as const}])),after.now));
});}
