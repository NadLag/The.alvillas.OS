import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {inventoryMovementReadAuthorityInTransaction} from "./movement-service";
import {inventorySourceScopes} from "./property-scopes";
import {InventoryStockLevelRepository,type InventoryStockRow} from "../infrastructure/stock-level-repository";
import {inventoryStockAvailability} from "../domain/movement";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "../domain/catalog-errors";
import {inventoryStockSelectionSchema,inventoryStockPageSchema,type InventoryStockSelection} from "../domain/stock-levels";
type Dependencies={db?:TenantTransactionRunner};
const item=(row:{itemId:string;key:string;labels:unknown;unit:string|null;category:string;itemArchivedAt:Date|null})=>({id:row.itemId,key:row.key,name:row.labels,unit:row.unit,category:row.category,retired:Boolean(row.itemArchivedAt)});
const location=(row:{locationId:string;label:string;kind:string;propertyId:string|null;propertyName:string|null;locationArchivedAt:Date|null;propertyArchivedAt:Date|null})=>({id:row.locationId,label:row.label,kind:row.kind,propertyId:row.propertyId,propertyName:row.propertyName,retired:Boolean(row.locationArchivedAt||row.propertyArchivedAt)});
const rowView=(row:InventoryStockRow)=>({item:item(row),location:location(row),position:inventoryStockAvailability({quantity:row.quantity,reserved:row.reserved,damaged:row.damaged,revision:row.revision}),lastMovementAt:row.lastMovementAt?.toISOString()??null,lastCountAt:row.lastCountAt?.toISOString()??null});
async function prepare(actor:AccountActorContext,tx:TenantTransaction,input:InventoryStockSelection){
 const context=await inventoryMovementReadAuthorityInTransaction(actor,tx),repository=new InventoryStockLevelRepository(tx,actor.organizationId),checks:CurrentAuthorityCheck[]=[...context.checks];
 let source:unknown,head:unknown;
 if(input.mode==="LOCATION"){
  const row=await context.inventory.locationCatalogById(input.locationId);if(!row||row.propertyId&&(!row.propertyXmin||!row.propertyTuple))throw new InventoryCatalogAccessError();head=row;
  if(row.propertyId)checks.push({action:"view",unconditional:true,resource:{type:"property",organizationId:actor.organizationId,id:row.propertyId,propertyId:row.propertyId,city:row.propertyCity,region:row.propertyRegion,dataClass:"operational"}});
  source={mode:input.mode,location:location({locationId:row.id,label:row.label,kind:row.kind,propertyId:row.propertyId,propertyName:row.propertyName,locationArchivedAt:row.archivedAt,propertyArchivedAt:row.propertyArchivedAt})};
 }else{
  const row=await context.inventory.catalogItemById(input.itemId);if(!row)throw new InventoryCatalogAccessError();head=row;source={mode:input.mode,item:item({itemId:row.id,key:row.key,labels:row.labels,unit:row.unit,category:row.category,itemArchivedAt:row.archivedAt})};
 }
 assertAccountAuthorization(actor,context.stored,context.now,checks,new InventoryCatalogAccessError());
 const held=inventorySourceScopes(actor.authContext,context.now),current=inventorySourceScopes(context.stored,context.now),[rows,totals]=await Promise.all([repository.page(input,held,current),repository.totals(input,held,current)]);
 return{...context,checks,source,rows,totals,witness:jsonbFingerprint({cap:context.cap,head,rows,totals})};
}
export async function inventoryStockPage(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=inventoryStockSelectionSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const before=await prepare(actor,tx,input),after=await prepare(actor,tx,input);if(before.witness!==after.witness)throw new InventoryCatalogConflictError();
  let canRecord=true;try{assertAccountAuthorization(actor,after.stored,after.now,[{action:"create",organizationOnly:true,resource:{type:"inventory_movement",organizationId:actor.organizationId,dataClass:"operational"}}],new InventoryCatalogAccessError());}catch(error){if(!(error instanceof InventoryCatalogAccessError))throw error;canRecord=false;}
  const value=inventoryStockPageSchema.parse({selection:input,source:after.source,items:after.rows.slice(0,50).map(rowView),totals:after.totals,next:after.rows.length>50?input.mode==="LOCATION"?after.rows[49].key:after.rows[49].locationId:null,observedAt:(await after.inventory.catalogClock()).toISOString(),canRecord}),shown=present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{type:"inventory_movement",organizationId:actor.organizationId,data:value},Object.fromEntries(Object.keys(value).map(key=>[key,{dataClass:"operational"as const}])),after.now);
  await recheckAccountAuthorization(actor,tx,await after.inventory.catalogClock(),after.checks,new InventoryCatalogAccessError());return inventoryStockPageSchema.parse(shown);
 });
}
