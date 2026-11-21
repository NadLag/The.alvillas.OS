import {z} from "zod";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Action,Resource} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {present} from "@/platform/authz/present";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {InventoryRepository,type InventoryLocationHead,type InventoryLocationProperty} from "../infrastructure/inventory-repository";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "../domain/catalog-errors";
import {inventoryLocationDefinition,inventoryLocationSelectionSchema,assertInventoryLocationCanRetire,inventoryLocationEntrySchema,inventoryLocationChangeSchema,inventoryLocationCommandSchema,inventoryLocationReceiptSchema,inventoryLocationChanged,inventoryLocationCancelled} from "../domain/location-catalog";
import {inventoryItemCancellationSchema} from "../domain/item-command";
import {inventoryLocationViewSchema} from "../domain/location-view";
import {inventoryPropertyScopes} from "./property-scopes";
type Dependencies={db?:TenantTransactionRunner;requestId?:string};
type Draft=z.infer<typeof inventoryLocationChangeSchema>;
const actions:Record<Draft["operation"],Action>={CREATE:"create",RENAME:"edit",ARCHIVE:"void",RESTORE:"edit"};
const resource=(organizationId:string,id?:string):Resource=>({type:"inventory_location",organizationId,id,dataClass:"operational"});
const json=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
function definition(row:InventoryLocationHead){return inventoryLocationEntrySchema.parse({kind:row.kind,propertyId:row.propertyId,label:row.label});}
const fingerprint=(row:InventoryLocationHead)=>jsonbFingerprint(row);
async function authority(actor:AccountActorContext,tx:TenantTransaction,action:Action="view",id?:string){
 const repository=new InventoryRepository(tx,actor.organizationId),[stored,now]=await Promise.all([authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.catalogClock()]);
 const checks:CurrentAuthorityCheck[]=[{action:"view",organizationOnly:true,resource:resource(actor.organizationId)},...action==="view"?[]:[{action,organizationOnly:true,resource:resource(actor.organizationId,id)}]];
 assertAccountAuthorization(actor,stored,now,checks,new InventoryCatalogAccessError());return{repository,stored,now,checks,cap:jsonbFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)})};
}
type Context=Awaited<ReturnType<typeof authority>>;
function propertyCheck(actor:AccountActorContext,context:Context,value:InventoryLocationProperty|null,required:boolean){
 if(!value){if(required)throw new InventoryCatalogAccessError();return null;}
 const check:CurrentAuthorityCheck={action:"view",unconditional:true,resource:{type:"property",organizationId:actor.organizationId,id:value.id,propertyId:value.id,city:value.city??undefined,region:value.region??undefined,dataClass:"operational"}};
 assertAccountAuthorization(actor,context.stored,context.now,[check],new InventoryCatalogAccessError());return check;
}
function originalProperty(row:InventoryLocationHead):InventoryLocationProperty|null{
 return row.propertyId&&row.propertyName!==null&&row.propertyXmin&&row.propertyTuple?{id:row.propertyId,name:row.propertyName,city:row.propertyCity,region:row.propertyRegion,archivedAt:row.propertyArchivedAt,xmin:row.propertyXmin,tuple:row.propertyTuple}:null;
}
function view(actor:AccountActorContext,context:Context,row:InventoryLocationHead){
 assertAccountAuthorization(actor,context.stored,context.now,[{action:"view",organizationOnly:true,resource:resource(actor.organizationId,row.id)}],new InventoryCatalogAccessError());propertyCheck(actor,context,originalProperty(row),Boolean(row.propertyId));
 const value={...definition(row),id:row.id,createdAt:row.createdAt.toISOString(),archivedAt:row.archivedAt?.toISOString()??null,fingerprint:fingerprint(row),propertyName:row.propertyName,propertyArchived:Boolean(row.propertyArchivedAt)};
 const shown=present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...resource(actor.organizationId,row.id),data:value},Object.fromEntries(Object.keys(value).map(key=>[key,{dataClass:"operational"as const}])),context.now),parsed=inventoryLocationViewSchema.safeParse(shown);if(!parsed.success)throw new InventoryCatalogAccessError();return parsed.data;
}
function capabilities(actor:AccountActorContext,context:Context){
 const permitted=(action:Action)=>{try{assertAccountAuthorization(actor,context.stored,context.now,[{action,organizationOnly:true,resource:resource(actor.organizationId)}],new InventoryCatalogAccessError());return true;}catch(error){if(error instanceof InventoryCatalogAccessError)return false;throw error;}};return{create:permitted("create"),edit:permitted("edit"),retire:permitted("void")};
}
async function prepare(actor:AccountActorContext,tx:TenantTransaction,draft:Draft){
 const context=await authority(actor,tx,actions[draft.operation],"id"in draft?draft.id:undefined),before=draft.operation==="CREATE"?draft.entry.propertyId?await context.repository.locationCatalogByProperty(draft.entry.propertyId):null:await context.repository.locationCatalogById(draft.id);
 if(draft.operation==="CREATE"&&before)throw new InventoryCatalogConflictError();if(draft.operation!=="CREATE"&&!before)throw new InventoryCatalogAccessError();if(before)view(actor,context,before);
 const entry="entry"in draft?inventoryLocationDefinition(draft.entry,before??undefined):definition(before!),property=entry.propertyId?await context.repository.locationCatalogProperty(entry.propertyId):null,sourceCheck=propertyCheck(actor,context,property,Boolean(entry.propertyId));
 if(property?.archivedAt)throw new InventoryCatalogAccessError();
 if(draft.operation==="RENAME"&&before?.archivedAt||draft.operation==="ARCHIVE"&&before?.archivedAt||draft.operation==="RESTORE"&&!before?.archivedAt)throw new InventoryCatalogConflictError();
 const stocks=draft.operation==="ARCHIVE"?await context.repository.locationCatalogStocks(before!.id):[];if(draft.operation==="ARCHIVE")assertInventoryLocationCanRetire(stocks);
 return{...context,checks:[...context.checks,...sourceCheck?[sourceCheck]:[]],before,entry,property,reviewFingerprint:jsonbFingerprint({draft,source:before?fingerprint(before):null,property,stocks,cap:context.cap})};
}
export async function assertInventoryLocationsViewer(actor:AccountActorContext,deps:Dependencies={}){
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const context=await authority(actor,tx);await recheckAccountAuthorization(actor,tx,await context.repository.catalogClock(),context.checks,new InventoryCatalogAccessError());});
}
export async function previewInventoryLocationChange(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const draft=inventoryLocationChangeSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const before=await prepare(actor,tx,draft),after=await prepare(actor,tx,draft);if(before.reviewFingerprint!==after.reviewFingerprint)throw new InventoryCatalogConflictError();return{draft,reviewFingerprint:after.reviewFingerprint,existing:after.before?view(actor,after,after.before):null,property:after.property?{id:after.property.id,name:after.property.name}:null};});
}
async function receipt(actor:AccountActorContext,tx:TenantTransaction,key:string){
 const context=await authority(actor,tx),row=await new OutboxRepository(tx,actor.organizationId).byIdempotencyKey("inventory-location:"+key);if(!row)return null;
 if(row.type===inventoryLocationCancelled){const value=inventoryItemCancellationSchema.parse(row.payload);if(value.actorId!==actor.actorId||value.organizationId!==actor.organizationId||value.idempotencyKey!==key)throw new InventoryCatalogAccessError();throw new InventoryCatalogConflictError();}
 const parsed=inventoryLocationReceiptSchema.safeParse(row.payload);if(row.type!==inventoryLocationChanged||!parsed.success||parsed.data.organizationId!==actor.organizationId||parsed.data.actorId!==actor.actorId)throw new InventoryCatalogAccessError();const location=await context.repository.locationCatalogById(parsed.data.locationId);if(!location)throw new InventoryCatalogAccessError();view(actor,context,location);const final=await authority(actor,tx),current=await context.repository.locationCatalogById(location.id);if(!current||fingerprint(current)!==fingerprint(location)||final.cap!==context.cap)throw new InventoryCatalogConflictError();view(actor,final,current);return parsed.data;
}
export async function publishInventoryLocationChange(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const command=inventoryLocationCommandSchema.parse(raw),hash=jsonbFingerprint(command);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new InventoryRepository(tx,actor.organizationId);await repository.lockLocationCommand(command.idempotencyKey);const saved=await receipt(actor,tx,command.idempotencyKey);if(saved){if(saved.commandHash!==hash)throw new InventoryCatalogConflictError();return{...saved,replayed:true};}
  const hint=await prepare(actor,tx,command.draft);await repository.lockLocationMetadata({id:hint.before?.id,propertyId:hint.entry.propertyId});const prepared=await prepare(actor,tx,command.draft);if(prepared.reviewFingerprint!==command.reviewFingerprint)throw new InventoryCatalogConflictError();
  let row:InventoryLocationHead;if(command.draft.operation==="CREATE")row=await repository.locationCatalogCreate(prepared.entry);else{if(await repository.locationCatalogUpdate(prepared.before!,{label:prepared.entry.label,archivedAt:command.draft.operation==="ARCHIVE"?await repository.catalogClock():null})!==1)throw new InventoryCatalogConflictError();row=(await repository.locationCatalogById(prepared.before!.id))!;}
  const after=view(actor,prepared,row),now=await repository.catalogClock(),value=inventoryLocationReceiptSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,locationId:row.id,operation:command.draft.operation,commandHash:hash,fingerprint:after.fingerprint});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"inventory.location."+({CREATE:"created",RENAME:"renamed",ARCHIVE:"archived",RESTORE:"restored"}as const)[command.draft.operation],resourceType:"inventory_location",resourceId:row.id,propertyScopeId:row.propertyId,before:prepared.before?view(actor,prepared,prepared.before):null,after,reason:command.draft.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await new OutboxRepository(tx,actor.organizationId).append(inventoryLocationChanged,json(value),"inventory-location:"+command.idempotencyKey,now);await recheckAccountAuthorization(actor,tx,await repository.catalogClock(),prepared.checks,new InventoryCatalogAccessError());const final=await authority(actor,tx),current=await repository.locationCatalogById(row.id);if(!current||fingerprint(current)!==after.fingerprint)throw new InventoryCatalogConflictError();view(actor,final,current);return{...value,replayed:false};
 });
}
export async function recoverInventoryLocationChange(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=z.object({idempotencyKey:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new InventoryRepository(tx,actor.organizationId);await repository.lockLocationCommand(input.idempotencyKey);const context=await authority(actor,tx),outbox=new OutboxRepository(tx,actor.organizationId),key="inventory-location:"+input.idempotencyKey,original=await outbox.byIdempotencyKey(key);
  if(original?.type===inventoryLocationCancelled){const value=inventoryItemCancellationSchema.parse(original.payload);if(value.actorId!==actor.actorId||value.organizationId!==actor.organizationId||value.idempotencyKey!==input.idempotencyKey)throw new InventoryCatalogAccessError();await recheckAccountAuthorization(actor,tx,await repository.catalogClock(),context.checks,new InventoryCatalogAccessError());return{recorded:false,receipt:null};}
  if(original)return{recorded:true,receipt:await receipt(actor,tx,input.idempotencyKey)};
  const now=await repository.catalogClock(),value=inventoryItemCancellationSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,...input});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:inventoryLocationCancelled,resourceType:"inventory_location_command",resourceId:input.idempotencyKey,after:value,reason:"Resolve an original inventory location request that was not recorded",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await outbox.append(inventoryLocationCancelled,json(value),key,now);await recheckAccountAuthorization(actor,tx,await repository.catalogClock(),context.checks,new InventoryCatalogAccessError());return{recorded:false,receipt:null};
 });
}
export async function getInventoryLocation(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=z.object({id:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const before=await authority(actor,tx),row=await before.repository.locationCatalogById(input.id);if(!row)throw new InventoryCatalogAccessError();view(actor,before,row);const after=await authority(actor,tx),current=await after.repository.locationCatalogById(input.id);if(!current||fingerprint(current)!==fingerprint(row)||after.cap!==before.cap)throw new InventoryCatalogConflictError();return view(actor,after,current);});
}
export async function inventoryLocationPage(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=inventoryLocationSelectionSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const before=await authority(actor,tx),select=(context:Context)=>context.repository.locationCatalogPage(input,inventoryPropertyScopes(actor.authContext,context.now),inventoryPropertyScopes(context.stored,context.now)),rows=await select(before),after=await authority(actor,tx),latest=await select(after);if(before.cap!==after.cap||jsonbFingerprint(rows)!==jsonbFingerprint(latest))throw new InventoryCatalogConflictError();return{items:latest.slice(0,50).map(row=>view(actor,after,row)),next:latest.length>50?latest[49].id:null,capabilities:capabilities(actor,after)};
 });
}
export async function inventoryLocationPropertyChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=z.object({query:z.string().trim().max(100).default(""),after:z.uuid().optional()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const before=await authority(actor,tx,"create"),select=(context:Context)=>context.repository.locationPropertyChoices(input,inventoryPropertyScopes(actor.authContext,context.now),inventoryPropertyScopes(context.stored,context.now)),rows=await select(before),after=await authority(actor,tx,"create"),latest=await select(after);if(before.cap!==after.cap||jsonbFingerprint(rows)!==jsonbFingerprint(latest))throw new InventoryCatalogConflictError();return{items:latest.slice(0,50).map(property=>{propertyCheck(actor,after,property,true);return{id:property.id,name:property.name};}),next:latest.length>50?latest[49].id:null};
 });
}
