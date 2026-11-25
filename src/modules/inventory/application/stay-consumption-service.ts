import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {localClockInstant} from "@/platform/time/local-instant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {inventoryMinimumsKey,inventoryMinimumsSchema} from "@/platform/config/inventory-policy";
import {inventoryMovementReadAuthorityInTransaction} from "./movement-service";
import {configuredInventoryItem} from "../domain/item-definition";
import {inventoryStaySelectionSchema,inventoryStayPageSchema,inventoryStayComparison,type InventoryStaySelection} from "../domain/stay-consumption";
import {InventoryStayConsumptionRepository} from "../infrastructure/stay-consumption-repository";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "../domain/catalog-errors";
async function prepare(actor:AccountActorContext,tx:TenantTransaction,input:InventoryStaySelection){
 const context=await inventoryMovementReadAuthorityInTransaction(actor,tx),repository=new InventoryStayConsumptionRepository(tx,actor.organizationId),stay=await repository.stay(input.reservationId);if(!stay)throw new InventoryCatalogAccessError();
 const base={organizationId:actor.organizationId,propertyId:stay.propertyId,city:stay.city,region:stay.region,dataClass:"operational"as const},checks:CurrentAuthorityCheck[]=[...context.checks,{action:"view",unconditional:true,resource:{...base,type:"property",id:stay.propertyId}},{action:"view",unconditional:true,resource:{...base,type:"reservation",id:stay.id,reservationId:stay.id,status:stay.status}},{action:"view",unconditional:true,resource:{...base,type:"config_rule"}}];
 assertAccountAuthorization(actor,context.stored,context.now,checks,new InventoryCatalogAccessError());
 const effectiveAt=new Date(localClockInstant(stay.checkIn.toISOString().slice(0,10)+"T00:00:00",stay.timezone,"earlier")),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId:stay.propertyId,source:stay.source,asOf:effectiveAt}),rule=await new ConfigRuleRepository(tx,actor.organizationId).resolve({key:inventoryMinimumsKey,scopes,asOf:effectiveAt}),configured=rule?inventoryMinimumsSchema.parse(rule.parsedValue).minimums:[],rows=await repository.rows(input,configured,stay.propertyId),applicable=!stay.archivedAt&&!stay.propertyArchivedAt&&!["CANCELLED","NO_SHOW"].includes(stay.status);
 const items=rows.slice(0,50).map(row=>{
  const setting=configured.find(entry=>entry.item===row.key),stored=row.itemId&&row.category?{category:row.category,unit:row.unit,labels:row.labels}:undefined,definition=setting?configuredInventoryItem(setting,stored):null,compatible=Boolean(!stored||!definition||stored.category===definition.category&&stored.unit===definition.unit),condition=!row.itemId?"MISSING"as const:row.archivedAt?"RETIRED"as const:!compatible?"INCOMPATIBLE"as const:"READY"as const;
  return{key:row.key,itemId:row.itemId,name:definition?.name??configuredInventoryItem({item:row.key,quantity:0},stored)?.name??{en:row.key,fr:row.key},unit:stored?.unit??definition?.unit??null,condition,...inventoryStayComparison(setting,row.actual,applicable,compatible),movementCount:row.movementCount};
 });
 const value=inventoryStayPageSchema.parse({selection:input,stay:{id:stay.id,reference:stay.reference,propertyId:stay.propertyId,propertyName:stay.propertyName,status:stay.status,checkIn:stay.checkIn.toISOString().slice(0,10),checkOut:stay.checkOut.toISOString().slice(0,10),timezone:stay.timezone,applicable},policy:rule?{id:rule.id,version:rule.version,effectiveAt:effectiveAt.toISOString()}:null,items,next:rows.length>50?rows[49].key:null,observedAt:context.now.toISOString()});
 return{...context,checks,value,witness:jsonbFingerprint({cap:context.cap,stay,rule,rows,value:{...value,observedAt:null}})};
}
export async function inventoryStayConsumptionPage(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner}={}){const input=inventoryStaySelectionSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
 const before=await prepare(actor,tx,input),after=await prepare(actor,tx,input);if(before.witness!==after.witness)throw new InventoryCatalogConflictError();await recheckAccountAuthorization(actor,tx,await after.inventory.catalogClock(),after.checks,new InventoryCatalogAccessError());
 return inventoryStayPageSchema.parse(present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{type:"inventory_movement",organizationId:actor.organizationId,data:after.value},Object.fromEntries(Object.keys(after.value).map(key=>[key,{dataClass:"operational"as const}])),after.now));
});}
