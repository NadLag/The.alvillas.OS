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
import {InventoryRepository,type InventoryItemHead} from "../infrastructure/inventory-repository";
import {inventoryItemDefinition,inventoryItemSelectionSchema,assertInventoryItemCanRetire,InventoryItemAccessError,InventoryItemConflictError,inventoryItemDraftSchema} from "../domain/item-catalog";
import {inventoryItemChangeSchema,inventoryItemCommandSchema,inventoryItemReceiptSchema,inventoryItemChanged,inventoryItemCancelled,inventoryItemCancellationSchema} from "../domain/item-command";

type Dependencies={db?:TenantTransactionRunner;requestId?:string};
type Draft=z.infer<typeof inventoryItemChangeSchema>;
const actions:Record<Draft["operation"],Action>={CREATE:"create",RENAME:"edit",ARCHIVE:"void",RESTORE:"edit"};
const resource=(organizationId:string,id?:string):Resource=>({type:"inventory_item",organizationId,id,dataClass:"operational"});
const identity=z.object({id:z.uuid()}).strict();
const json=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
function definition(row:InventoryItemHead){return inventoryItemDraftSchema.parse({key:row.key,name:row.labels,category:row.category,unit:row.unit});}
function fingerprint(row:InventoryItemHead){return jsonbFingerprint({...row,labels:definition(row).name});}
function view(actor:AccountActorContext,stored:Awaited<ReturnType<typeof authContextForAccountInTransaction>>,row:InventoryItemHead,now:Date){
 assertAccountAuthorization(actor,stored,now,[{action:"view",resource:resource(actor.organizationId,row.id)}],new InventoryItemAccessError());
 const data=present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...resource(actor.organizationId,row.id),data:definition(row)},{name:{dataClass:"operational"},key:{dataClass:"operational"},unit:{dataClass:"operational"},category:{dataClass:"operational"}},now);
 const parsed=inventoryItemDraftSchema.safeParse(data);if(!parsed.success)throw new InventoryItemAccessError();
 assertAccountAuthorization(actor,stored,now,[{action:"view",resource:resource(actor.organizationId,row.id)}],new InventoryItemAccessError());
 return{id:row.id,...parsed.data,createdAt:row.createdAt.toISOString(),archivedAt:row.archivedAt?.toISOString()??null,fingerprint:fingerprint(row)};
}
async function authority(actor:AccountActorContext,tx:TenantTransaction,action:Action="view",id?:string){
 const repository=new InventoryRepository(tx,actor.organizationId),[stored,now]=await Promise.all([authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.catalogClock()]);
 const checks:CurrentAuthorityCheck[]=[{action:"view",organizationOnly:true,unconditional:true,resource:resource(actor.organizationId)},...action==="view"?[]:[{action,organizationOnly:true,unconditional:true,resource:resource(actor.organizationId,id)}]];
 assertAccountAuthorization(actor,stored,now,checks,new InventoryItemAccessError());return{repository,stored,now,checks,cap:jsonbFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)})};
}
export async function assertInventoryCatalogViewer(actor:AccountActorContext,deps:Dependencies={}){
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const context=await authority(actor,tx);await recheckAccountAuthorization(actor,tx,await context.repository.catalogClock(),context.checks,new InventoryItemAccessError());});
}
function capabilities(actor:AccountActorContext,context:Awaited<ReturnType<typeof authority>>){
 const permitted=(action:Action)=>{try{assertAccountAuthorization(actor,context.stored,context.now,[{action,organizationOnly:true,unconditional:true,resource:resource(actor.organizationId)}],new InventoryItemAccessError());return true;}catch(error){if(error instanceof InventoryItemAccessError)return false;throw error;}};
 return{create:permitted("create"),edit:permitted("edit"),retire:permitted("void")};
}
async function prepare(actor:AccountActorContext,tx:TenantTransaction,draft:Draft){
 const context=await authority(actor,tx,actions[draft.operation],"id"in draft?draft.id:undefined);
 const before=draft.operation==="CREATE"?await context.repository.catalogItemByKey(draft.entry.key):await context.repository.catalogItemById(draft.id);
 if(draft.operation==="CREATE"&&before)throw new InventoryItemConflictError();
 if(draft.operation!=="CREATE"&&!before)throw new InventoryItemAccessError();
 if(before)view(actor,context.stored,before,context.now);
 const entry="entry"in draft?inventoryItemDefinition(draft.entry,before?definition(before):undefined):definition(before!);
 if(draft.operation==="RENAME"&&before?.archivedAt||draft.operation==="ARCHIVE"&&before?.archivedAt||draft.operation==="RESTORE"&&!before?.archivedAt)throw new InventoryItemConflictError();
 const stocks=draft.operation==="ARCHIVE"?await context.repository.itemStockLocations(before!.id):[];if(draft.operation==="ARCHIVE")assertInventoryItemCanRetire(stocks);
 return{...context,before,entry,reviewFingerprint:jsonbFingerprint({draft,source:before?fingerprint(before):null,stocks,cap:context.cap})};
}
export async function previewInventoryItemChange(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const draft=inventoryItemChangeSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const before=await prepare(actor,tx,draft),after=await prepare(actor,tx,draft);if(before.reviewFingerprint!==after.reviewFingerprint)throw new InventoryItemConflictError();
  return{draft,reviewFingerprint:after.reviewFingerprint,existing:after.before?view(actor,after.stored,after.before,after.now):null};
 });
}
async function receipt(actor:AccountActorContext,tx:TenantTransaction,key:string){
 await authority(actor,tx);const row=await new OutboxRepository(tx,actor.organizationId).byIdempotencyKey("inventory-item:"+key);if(!row)return null;
 if(row.type===inventoryItemCancelled){const cancelled=inventoryItemCancellationSchema.parse(row.payload);if(cancelled.actorId!==actor.actorId||cancelled.organizationId!==actor.organizationId||cancelled.idempotencyKey!==key)throw new InventoryItemAccessError();throw new InventoryItemConflictError();}
 const parsed=inventoryItemReceiptSchema.safeParse(row.payload);if(row.type!==inventoryItemChanged||!parsed.success||parsed.data.organizationId!==actor.organizationId||parsed.data.actorId!==actor.actorId)throw new InventoryItemAccessError();
 const context=await authority(actor,tx),item=await context.repository.catalogItemById(parsed.data.itemId);if(!item)throw new InventoryItemAccessError();view(actor,context.stored,item,context.now);return parsed.data;
}
export async function publishInventoryItemChange(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const command=inventoryItemCommandSchema.parse(raw),hash=jsonbFingerprint(command);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new InventoryRepository(tx,actor.organizationId);await repository.lockCatalogCommand(command.idempotencyKey);
  const saved=await receipt(actor,tx,command.idempotencyKey);if(saved){if(saved.commandHash!==hash)throw new InventoryItemConflictError();return{...saved,replayed:true};}
  const hint=await prepare(actor,tx,command.draft);await repository.lockCatalogItem(hint.entry.key);const prepared=await prepare(actor,tx,command.draft);if(prepared.reviewFingerprint!==command.reviewFingerprint)throw new InventoryItemConflictError();
  const priorLabels=prepared.before?.labels&&typeof prepared.before.labels==="object"&&!Array.isArray(prepared.before.labels)?prepared.before.labels:{};
  const labels="entry"in command.draft?json({...priorLabels,...prepared.entry.name,ar:prepared.entry.name.ar}):json(priorLabels);
  let row:InventoryItemHead;
  if(command.draft.operation==="CREATE")row=await repository.catalogCreate({key:prepared.entry.key,category:prepared.entry.category,unit:prepared.entry.unit,labels});
  else{if(await repository.catalogUpdate(prepared.before!,{labels,archivedAt:command.draft.operation==="ARCHIVE"?await repository.catalogClock():null})!==1)throw new InventoryItemConflictError();row=(await repository.catalogItemById(prepared.before!.id))!;}
  const after=view(actor,prepared.stored,row,prepared.now),now=await repository.catalogClock(),value=inventoryItemReceiptSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,itemId:row.id,operation:command.draft.operation,commandHash:hash,fingerprint:after.fingerprint});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"inventory.item."+({CREATE:"created",RENAME:"renamed",ARCHIVE:"archived",RESTORE:"restored"}as const)[command.draft.operation],resourceType:"inventory_item",resourceId:row.id,before:prepared.before?view(actor,prepared.stored,prepared.before,prepared.now):null,after,reason:command.draft.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await new OutboxRepository(tx,actor.organizationId).append(inventoryItemChanged,json(value),"inventory-item:"+command.idempotencyKey,now);
  await recheckAccountAuthorization(actor,tx,await repository.catalogClock(),prepared.checks,new InventoryItemAccessError());const current=await repository.catalogItemById(row.id);if(!current||fingerprint(current)!==after.fingerprint)throw new InventoryItemConflictError();return{...value,replayed:false};
 });
}
export async function recoverInventoryItemChange(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=z.object({idempotencyKey:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new InventoryRepository(tx,actor.organizationId);await repository.lockCatalogCommand(input.idempotencyKey);const context=await authority(actor,tx),outbox=new OutboxRepository(tx,actor.organizationId),key="inventory-item:"+input.idempotencyKey,original=await outbox.byIdempotencyKey(key);
  if(original?.type===inventoryItemCancelled){const cancellation=inventoryItemCancellationSchema.parse(original.payload);if(cancellation.actorId!==actor.actorId||cancellation.organizationId!==actor.organizationId||cancellation.idempotencyKey!==input.idempotencyKey)throw new InventoryItemAccessError();return{recorded:false,receipt:null};}
  if(original){const found=await receipt(actor,tx,input.idempotencyKey);return{recorded:true,receipt:found};}
  // Resolve a missing request durably under the same command lock. A late
  // original request can never materialize after this negative acknowledgement.
  const now=await repository.catalogClock(),value=inventoryItemCancellationSchema.parse({schemaVersion:1,organizationId:actor.organizationId,actorId:actor.actorId,...input});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:inventoryItemCancelled,resourceType:"inventory_item_command",resourceId:input.idempotencyKey,after:value,reason:"Resolve an original inventory item request that was not recorded",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await outbox.append(inventoryItemCancelled,json(value),key,now);await recheckAccountAuthorization(actor,tx,await repository.catalogClock(),context.checks,new InventoryItemAccessError());return{recorded:false,receipt:null};
 });
}
export async function getInventoryItem(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=identity.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const before=await authority(actor,tx),row=await before.repository.catalogItemById(input.id);if(!row)throw new InventoryItemAccessError();view(actor,before.stored,row,before.now);const after=await authority(actor,tx),latest=await after.repository.catalogItemById(input.id);if(!latest||fingerprint(row)!==fingerprint(latest)||after.cap!==before.cap)throw new InventoryItemConflictError();return view(actor,after.stored,latest,after.now);});
}
export async function inventoryItemPage(actor:AccountActorContext,raw:unknown,deps:Dependencies={}){
 const input=inventoryItemSelectionSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const before=await authority(actor,tx),rows=await before.repository.catalogPage(input),after=await authority(actor,tx),latest=await after.repository.catalogPage(input);if(before.cap!==after.cap||jsonbFingerprint(rows)!==jsonbFingerprint(latest))throw new InventoryItemConflictError();return{items:latest.slice(0,50).map(row=>view(actor,after.stored,row,after.now)),next:latest.length>50?latest[49].key:null,capabilities:capabilities(actor,after)};});
}
