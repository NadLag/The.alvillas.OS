import {z} from "zod";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {Action,Resource} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {InventoryRepository} from "../infrastructure/inventory-repository";
import {InventoryMovementRepository,type InventoryMovementRow} from "../infrastructure/movement-repository";
import {InventoryCatalogAccessError,InventoryCatalogConflictError,InventoryCatalogDefinitionError} from "../domain/catalog-errors";
import {planInventoryMovement,planInventoryMovementReversal,inventoryStockAvailability,type InventoryMovementPosition} from "../domain/movement";
import {inventoryMovementRequestSchema,inventoryMovementCommandSchema,inventoryMovementReceiptSchema,inventoryMovementRecorded,inventoryMovementCancelled,type InventoryMovementRequest} from "../domain/movement-command";
import {inventoryItemCancellationSchema} from "../domain/item-command";
import {inventoryCategorySchema} from "@/platform/config/inventory-policy";
import {inventoryLocationKindSchema} from "../domain/location-catalog";
import {inventoryMovementPreviewSchema,inventoryMovementHistorySchema} from "../domain/movement-view";
import {inventorySourceScopes} from "./property-scopes";
import {appendInventoryReorderSignal} from "@/platform/inventory/reorder-events";
type Dependencies={db?:TenantTransactionRunner;requestId?:string};
const resource=(organizationId:string,type="inventory_movement",id?:string):Resource=>({type,organizationId,id,dataClass:"operational"});
const json=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
const identity=z.object({id:z.uuid()}).strict();
const selection=z.object({groupId:z.uuid().optional(),locationId:z.uuid().optional(),itemId:z.uuid().optional(),after:z.uuid().optional()}).strict();
async function authority(actor:AccountActorContext,tx:TenantTransaction,actions:readonly Action[]=["view"]){
 const inventory=new InventoryRepository(tx,actor.organizationId),[stored,now]=await Promise.all([authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),inventory.catalogClock()]);
 const checks:CurrentAuthorityCheck[]=[...new Set(["view"as const,...actions])].map(action=>({action,organizationOnly:true,resource:resource(actor.organizationId)}));
 for(const type of["inventory_item","inventory_location"])checks.push({action:"view",organizationOnly:true,resource:resource(actor.organizationId,type)});
 assertAccountAuthorization(actor,stored,now,checks,new InventoryCatalogAccessError());
 return{inventory,movements:new InventoryMovementRepository(tx,actor.organizationId),stored,now,checks,cap:jsonbFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)})};
}
type Authority=Awaited<ReturnType<typeof authority>>;
export const inventoryMovementReadAuthorityInTransaction=(actor:AccountActorContext,tx:TenantTransaction)=>authority(actor,tx);
export const inventoryMovementAuthorityInTransaction=authority;
async function sources(actor:AccountActorContext,context:Authority,itemId:string,locationIds:readonly string[],reservationIds:readonly string[],writing=false){
 const item=await context.inventory.catalogItemById(itemId),locations=await Promise.all([...new Set(locationIds)].sort().map(id=>context.inventory.locationCatalogById(id))),reservations=await Promise.all([...new Set(reservationIds)].sort().map(id=>context.movements.reservation(id)));
 if(!item||locations.some(row=>!row)||reservations.some(row=>!row))throw new InventoryCatalogAccessError();
 const actualLocations=locations.filter(row=>row!==null),actualReservations=reservations.filter(row=>row!==null),checks:CurrentAuthorityCheck[]=[];
 if(writing&&(item.archivedAt||actualLocations.some(row=>row.archivedAt||row.propertyArchivedAt)||actualReservations.some(row=>row.propertyArchivedAt)))throw new InventoryCatalogAccessError();
 for(const row of actualLocations)if(row.propertyId){
  if(!row.propertyXmin||!row.propertyTuple)throw new InventoryCatalogAccessError();
  checks.push({action:"view",unconditional:true,resource:{...resource(actor.organizationId,"property",row.propertyId),propertyId:row.propertyId,city:row.propertyCity,region:row.propertyRegion}});
 }
 for(const row of actualReservations){
  checks.push({action:"view",unconditional:true,resource:{...resource(actor.organizationId,"reservation",row.id),reservationId:row.id,propertyId:row.propertyId,city:row.city,region:row.region,status:row.status}});
  checks.push({action:"view",unconditional:true,resource:{...resource(actor.organizationId,"property",row.propertyId),propertyId:row.propertyId,city:row.city,region:row.region}});
 }
 assertAccountAuthorization(actor,context.stored,context.now,checks,new InventoryCatalogAccessError());
 return{item,locations:actualLocations,reservations:actualReservations,checks,witness:jsonbFingerprint({item,locations:actualLocations,reservations:actualReservations})};
}
function rowDelta(row:InventoryMovementRow){return{locationId:row.locationId,itemId:row.itemId,quantity:row.quantity,reserved:row.reserved,damaged:row.damaged,reservationId:row.reservationId};}
function rowLine(row:InventoryMovementRow){return{id:row.id,...rowDelta(row),revision:row.revision,leg:row.leg,reversesMovementId:row.reversesMovementId};}
async function prepare(actor:AccountActorContext,tx:TenantTransaction,draft:InventoryMovementRequest){
 const context=await authority(actor,tx,draft.kind==="REVERSAL"?["void"]:draft.kind==="ADJUSTMENT"?["create","override"]:["create"]),original=draft.kind==="REVERSAL"?await context.movements.group(draft.originalGroupId):[];
 if(draft.kind==="REVERSAL"&&(!original.length||original.some(row=>row.kind==="REVERSAL"||row.reversedBy)))throw new InventoryCatalogConflictError();
 const itemId=draft.kind==="REVERSAL"?original[0].itemId:draft.itemId,locationIds=draft.kind==="REVERSAL"?original.map(row=>row.locationId):[draft.locationId,..."destinationLocationId"in draft?[draft.destinationLocationId]:[]],reservationIds=draft.kind==="REVERSAL"?original.flatMap(row=>row.reservationId?[row.reservationId]:[]):"reservationId"in draft&&draft.reservationId?[draft.reservationId]:[],source=await sources(actor,context,itemId,locationIds,reservationIds,true);
 const positions=new Map<string,InventoryMovementPosition>();for(const row of source.locations)positions.set(row.id,await context.movements.position(row.id,itemId));
 let projected:ReturnType<typeof planInventoryMovementReversal>;
 if(draft.kind==="REVERSAL")projected=planInventoryMovementReversal(original.map(rowDelta),positions);
 else{
  const reservation=source.reservations[0];if(reservation&&source.locations.some(row=>row.propertyId&&row.propertyId!==reservation.propertyId))throw new InventoryCatalogDefinitionError();
  projected=planInventoryMovement(draft,{item:{id:source.item.id,category:inventoryCategorySchema.parse(source.item.category),archived:Boolean(source.item.archivedAt)},locations:source.locations.map(row=>({id:row.id,kind:inventoryLocationKindSchema.parse(row.kind),archived:Boolean(row.archivedAt)})),positions,...reservation?{reservation:{id:reservation.id,active:!reservation.archivedAt&&!["CANCELLED","NO_SHOW","CLOSED"].includes(reservation.status),outstanding:await context.movements.outstanding(reservation.id,draft.locationId,itemId)}}:{}}).projected;
 }
 for(const row of projected)if(row.line.reservationId&&BigInt(row.line.reserved)<0n&&BigInt(await context.movements.outstanding(row.line.reservationId,row.line.locationId,itemId))+BigInt(row.line.reserved)<0n)throw new InventoryCatalogConflictError();
 return{...context,source,positions,original,projected,checks:[...context.checks,...source.checks],reviewFingerprint:jsonbFingerprint({draft,source:source.witness,positions:[...positions],original,cap:context.cap})};
}
type Prepared=Awaited<ReturnType<typeof prepare>>;
function review(draft:InventoryMovementRequest,value:Prepared){return inventoryMovementPreviewSchema.parse({draft,reviewFingerprint:value.reviewFingerprint,item:{id:value.source.item.id,key:value.source.item.key,name:value.source.item.labels,unit:value.source.item.unit,category:value.source.item.category},lines:value.projected.map(({line,position})=>({locationId:line.locationId,label:value.source.locations.find(row=>row.id===line.locationId)!.label,before:inventoryStockAvailability(value.positions.get(line.locationId)!),delta:line,after:position}))});}
async function verifySources(actor:AccountActorContext,tx:TenantTransaction,value:{source:Prepared["source"];checks:CurrentAuthorityCheck[];cap:string}){
 const current=await authority(actor,tx),latest=await sources(actor,current,value.source.item.id,value.source.locations.map(row=>row.id),value.source.reservations.map(row=>row.id));
 if(current.cap!==value.cap||latest.witness!==value.source.witness)throw new InventoryCatalogConflictError();
 await recheckAccountAuthorization(actor,tx,await current.inventory.catalogClock(),value.checks,new InventoryCatalogAccessError());
}
export async function assertInventoryMovementsViewer(actor:AccountActorContext,deps:Dependencies={}){return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const context=await authority(actor,tx);await recheckAccountAuthorization(actor,tx,await context.inventory.catalogClock(),context.checks,new InventoryCatalogAccessError());});}
export const inventoryMovementSourcesInTransaction=sources;
export const verifyInventoryMovementSourcesInTransaction=verifySources;
export async function previewInventoryMovement(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const draft=inventoryMovementRequestSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const before=await prepare(actor,tx,draft),after=await prepare(actor,tx,draft);if(before.reviewFingerprint!==after.reviewFingerprint)throw new InventoryCatalogConflictError();return review(draft,after);});
}
async function readReceipt(actor:AccountActorContext,tx:TenantTransaction,key:string){
 const context=await authority(actor,tx),row=await new OutboxRepository(tx,actor.organizationId).byIdempotencyKey("inventory-movement:"+key);if(!row)return null;
 if(row.type===inventoryMovementCancelled){const value=inventoryItemCancellationSchema.parse(row.payload);if(value.actorId!==actor.actorId||value.organizationId!==actor.organizationId||value.idempotencyKey!==key)throw new InventoryCatalogAccessError();throw new InventoryCatalogConflictError();}
 const parsed=inventoryMovementReceiptSchema.safeParse(row.payload);if(row.type!==inventoryMovementRecorded||!parsed.success||parsed.data.organizationId!==actor.organizationId||parsed.data.actorId!==actor.actorId||parsed.data.groupId!==key)throw new InventoryCatalogAccessError();
 const lines=await context.movements.group(parsed.data.groupId);if(!lines.length||jsonbFingerprint(lines.map(rowLine))!==jsonbFingerprint(parsed.data.lines))throw new InventoryCatalogAccessError();
 const source=await sources(actor,context,lines[0].itemId,lines.map(line=>line.locationId),lines.flatMap(line=>line.reservationId?[line.reservationId]:[]));await verifySources(actor,tx,{source,checks:[...context.checks,...source.checks],cap:context.cap});return parsed.data;
}
export async function publishInventoryMovement(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const command=inventoryMovementCommandSchema.parse(raw),hash=jsonbFingerprint(command);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const inventory=new InventoryRepository(tx,actor.organizationId);await inventory.lockMovementCommand(command.idempotencyKey);const saved=await readReceipt(actor,tx,command.idempotencyKey);if(saved){if(saved.commandHash!==hash)throw new InventoryCatalogConflictError();return{...saved,replayed:true};}
  const hint=await prepare(actor,tx,command.draft);await inventory.lockMovementStreams(hint.source.item,hint.source.locations);const prepared=await prepare(actor,tx,command.draft);if(prepared.reviewFingerprint!==command.reviewFingerprint)throw new InventoryCatalogConflictError();
  const now=await inventory.catalogClock(),lines=prepared.projected.map(({line,position},index)=>({id:crypto.randomUUID(),...line,revision:position.revision,leg:index+1,reversesMovementId:command.draft.kind==="REVERSAL"?prepared.original[index].id:null})),value=inventoryMovementReceiptSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,groupId:command.idempotencyKey,kind:command.draft.kind,commandHash:hash,lines});
  const snapshots=lines.map(line=>{const location=prepared.source.locations.find(row=>row.id===line.locationId)!;return{request:command.draft,before:prepared.positions.get(line.locationId),item:{id:prepared.source.item.id,key:prepared.source.item.key,category:prepared.source.item.category,unit:prepared.source.item.unit},location:{id:location.id,kind:location.kind,propertyId:location.propertyId}};});
  await prepared.movements.record({groupId:value.groupId,actorId:actor.actorId,kind:value.kind,lines:value.lines,sources:snapshots,at:now});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:inventoryMovementRecorded,resourceType:"inventory_movement",resourceId:value.groupId,propertyScopeId:prepared.source.locations.length===1?prepared.source.locations[0].propertyId:null,after:value,reason:command.draft.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await new OutboxRepository(tx,actor.organizationId).append(inventoryMovementRecorded,json(value),"inventory-movement:"+value.groupId,now);
  for(const line of value.lines)await appendInventoryReorderSignal(tx,actor,{locationId:line.locationId,itemId:line.itemId,revision:line.revision,source:{kind:"MOVEMENT",id:value.groupId}},now);
  await verifySources(actor,tx,prepared);return{...value,replayed:false};
 });
}
export async function recoverInventoryMovement(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=z.object({idempotencyKey:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const inventory=new InventoryRepository(tx,actor.organizationId);await inventory.lockMovementCommand(input.idempotencyKey);const context=await authority(actor,tx),outbox=new OutboxRepository(tx,actor.organizationId),key="inventory-movement:"+input.idempotencyKey,original=await outbox.byIdempotencyKey(key);
  if(original?.type===inventoryMovementCancelled){const value=inventoryItemCancellationSchema.parse(original.payload);if(value.actorId!==actor.actorId||value.organizationId!==actor.organizationId||value.idempotencyKey!==input.idempotencyKey)throw new InventoryCatalogAccessError();await recheckAccountAuthorization(actor,tx,await inventory.catalogClock(),context.checks,new InventoryCatalogAccessError());return{recorded:false,receipt:null};}
  if(original)return{recorded:true,receipt:await readReceipt(actor,tx,input.idempotencyKey)};
  const now=await inventory.catalogClock(),value=inventoryItemCancellationSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,...input});await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:inventoryMovementCancelled,resourceType:"inventory_movement_command",resourceId:input.idempotencyKey,after:value,reason:"Resolve an original inventory movement request that was not recorded",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});await outbox.append(inventoryMovementCancelled,json(value),key,now);await recheckAccountAuthorization(actor,tx,await inventory.catalogClock(),context.checks,new InventoryCatalogAccessError());return{recorded:false,receipt:null};
 });
}
async function groupView(actor:AccountActorContext,tx:TenantTransaction,context:Authority,id:string){
 const lines=await context.movements.group(id);if(!lines.length)throw new InventoryCatalogAccessError();const source=await sources(actor,context,lines[0].itemId,lines.map(row=>row.locationId),lines.flatMap(row=>row.reservationId?[row.reservationId]:[]));
 const draft=z.object({request:inventoryMovementRequestSchema}).passthrough().parse(lines[0].sourceSnapshot).request,value={id,kind:lines[0].kind,createdAt:lines[0].createdAt.toISOString(),reason:draft.reason,item:{id:source.item.id,key:source.item.key,name:source.item.labels,unit:source.item.unit},originalGroupId:draft.kind==="REVERSAL"?draft.originalGroupId:null,reversedBy:lines[0].reversedBy,lines:lines.map(row=>({...rowLine(row),label:source.locations.find(location=>location.id===row.locationId)!.label}))};
 const shown=present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...resource(actor.organizationId,"inventory_movement",id),data:value},Object.fromEntries(Object.keys(value).map(key=>[key,{dataClass:"operational"as const}])),context.now);if(jsonbFingerprint(shown)!==jsonbFingerprint(value))throw new InventoryCatalogAccessError();await verifySources(actor,tx,{source,checks:[...context.checks,...source.checks],cap:context.cap});const latest=await context.movements.group(id);if(jsonbFingerprint(latest)!==jsonbFingerprint(lines))throw new InventoryCatalogConflictError();return inventoryMovementHistorySchema.parse(value);
}
export async function inventoryMovementReservationChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=z.object({query:z.string().trim().max(100).default(""),active:z.boolean().default(true),after:z.uuid().optional()}).strict().parse(raw);
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const before=await authority(actor,tx),select=(context:Authority)=>context.movements.reservationChoices(input,inventorySourceScopes(actor.authContext,context.now),inventorySourceScopes(context.stored,context.now),inventorySourceScopes(actor.authContext,context.now,"reservation"),inventorySourceScopes(context.stored,context.now,"reservation")),rows=await select(before),after=await authority(actor,tx),latest=await select(after);if(before.cap!==after.cap||jsonbFingerprint(rows)!==jsonbFingerprint(latest))throw new InventoryCatalogConflictError();return{items:latest.slice(0,50).map(row=>({id:row.id,label:row.label})),next:latest.length>50?latest[49].id:null};
 });
}
export async function getInventoryMovement(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){const input=identity.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>groupView(actor,tx,await authority(actor,tx),input.id));}
export async function inventoryMovementPage(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=selection.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const context=await authority(actor,tx),select=(value:Authority)=>value.movements.page(input,inventorySourceScopes(actor.authContext,value.now),inventorySourceScopes(value.stored,value.now),inventorySourceScopes(actor.authContext,value.now,"reservation"),inventorySourceScopes(value.stored,value.now,"reservation")),ids=await select(context),items:Awaited<ReturnType<typeof groupView>>[]=[];
  for(const row of ids.slice(0,50))try{items.push(await groupView(actor,tx,context,row.id));}catch(error){if(!(error instanceof InventoryCatalogAccessError))throw error;}
  const final=await authority(actor,tx);if(final.cap!==context.cap||jsonbFingerprint(await select(final))!==jsonbFingerprint(ids))throw new InventoryCatalogConflictError();
  const permitted=(action:Action)=>{try{assertAccountAuthorization(actor,final.stored,final.now,[{action,organizationOnly:true,resource:resource(actor.organizationId)}],new InventoryCatalogAccessError());return true;}catch(error){if(error instanceof InventoryCatalogAccessError)return false;throw error;}};
  return{items,next:ids.length>50?ids[49].id:null,capabilities:{create:permitted("create"),reverse:permitted("void"),adjust:permitted("create")&&permitted("override")}};
 });
}
