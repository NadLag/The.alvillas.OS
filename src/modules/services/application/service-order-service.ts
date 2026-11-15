import {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {ServiceOrderRepository} from "../infrastructure/service-order-repository";
import {serviceOrderRequestSchema,serviceOrderCreateSchema,serviceOrderRecoverSchema,ServiceOrderAccessError,ServiceOrderConflictError} from "../domain/service-order";
import {inspectNewServiceOrder,serviceOrderAuthority} from "./service-order-source";

type Dependencies={db?:TenantTransactionRunner;requestId:string;ipAddress?:string|null};
const asJson=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
type Order=NonNullable<Awaited<ReturnType<ServiceOrderRepository["original"]>>>;
export const serviceOrderChanged="service.order.changed";

export function serviceOrderMetadata(row:NonNullable<Awaited<ReturnType<ServiceOrderRepository["head"]>>>){
 return{id:row.id,propertyId:row.propertyId,reservationId:row.reservationId,serviceKey:row.serviceKey,
  title:row.titleTranslations,serviceDate:row.serviceDate.toISOString().slice(0,10),lastServiceDate:row.lastServiceDate.toISOString().slice(0,10),
  quantity:Number(row.quantity),guests:row.guestCount,state:row.state,version:row.version,taskId:row.taskId,createdAt:row.createdAt.toISOString()};
}

/** Only immutable native event identity enters the broader audit and outbox.
 * Original private reasons and prices stay in the authorized order history. */
export async function appendServiceOrderHistory(actor:AccountActorContext,tx:TenantTransaction,order:Order,input:{fromState:string|null;commandKey:string;commandHash:string;reviewFingerprint:string;reason:string},deps:Pick<Dependencies,"requestId"|"ipAddress">){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),event=await repository.event({orderId:order.id,version:order.version,fromState:input.fromState,toState:order.state,
  snapshot:{state:order.state,totalAmount:order.totalAmount?.toFixed(2)??null,currency:order.currency,quoteReference:order.quoteReference,taskId:order.taskId},
  commandKey:input.commandKey,commandHash:input.commandHash,reviewFingerprint:input.reviewFingerprint,createdBy:actor.actorId,reason:input.reason,requestId:deps.requestId,createdAt:order.updatedAt});
 const receipt={schemaVersion:1,actorId:actor.actorId,orderId:order.id,eventId:event.id,version:event.version,state:event.toState,commandKey:event.commandKey,commandHash:event.commandHash,reviewFingerprint:event.reviewFingerprint};
 await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:serviceOrderChanged,resourceType:"service_order",resourceId:order.id,propertyScopeId:order.propertyId,
  after:receipt,reason:null,requestId:deps.requestId,ipAddress:deps.ipAddress??null,occurredAt:event.createdAt});
 await new OutboxRepository(tx,actor.organizationId).append(serviceOrderChanged,receipt,"service-order:"+event.commandKey,event.createdAt);
 return{orderId:order.id,eventId:event.id,version:event.version,state:event.toState};
}

export async function previewServiceOrder(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const request=serviceOrderRequestSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const source=await inspectNewServiceOrder(actor,tx,request),result={reviewFingerprint:source.reviewFingerprint,request,dimensions:source.dimensions,title:source.entry.name,
   quoteRequired:source.price.kind==="QUOTE_REQUIRED",totalAmount:source.price.kind==="PRICED"?source.price.amount.toJSON().amount:null,currency:source.entry.currency!};
  const current=await inspectNewServiceOrder(actor,tx,request);if(current.reviewFingerprint!==source.reviewFingerprint)throw new ServiceOrderConflictError();
  return present({...actor.authContext,visibleDataClasses:new Set(["operational","financial"]as const)},"view",{...source.resource,data:result},
   {totalAmount:{dataClass:"financial"},currency:{dataClass:"financial"}});
 },{timeout:120000});
}

/** One native order, event, audit and receipt commit together. No collection,
 * expense, compensation, journal, provider call or delivery is asserted here. */
export async function createServiceOrder(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const command=serviceOrderCreateSchema.parse(raw),hash=jsonbFingerprint({operation:"CREATE",command});
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ServiceOrderRepository(tx,actor.organizationId);await repository.lockCommand(command.idempotencyKey);
  const recorded=await repository.byNonce(command.idempotencyKey);
  if(recorded){
   if(recorded.createdBy!==actor.actorId||recorded.commandHash!==hash)throw new ServiceOrderConflictError();
   const head=await repository.head(recorded.orderId);if(!head||head.propertyId!==command.request.propertyId||head.reservationId!==command.request.reservationId)throw new ServiceOrderAccessError();
   await serviceOrderAuthority(actor,tx,head);return{orderId:head.id,eventId:recorded.id,version:recorded.version,state:recorded.toState,replayed:true};
  }
  const source=await inspectNewServiceOrder(actor,tx,command.request);if(source.reviewFingerprint!==command.reviewFingerprint)throw new ServiceOrderConflictError();
  const order=await repository.create({propertyId:source.property.id,reservationId:source.reservation.id,catalogRuleId:source.catalog.rule!.id,catalogRuleVersion:source.catalog.rule!.version,
   serviceKey:source.entry.key,titleTranslations:asJson(source.entry.name),serviceDate:new Date(command.request.serviceDate+"T00:00:00Z"),lastServiceDate:new Date(command.request.lastServiceDate+"T00:00:00Z"),
   quantity:BigInt(command.request.quantity),guestCount:command.request.guests,requestSnapshot:asJson({...command.request,dimensions:source.dimensions}),catalogSnapshot:asJson(source.snapshot),sourceWitnesses:asJson(source.witnesses),
   totalAmount:source.price.kind==="PRICED"?new Prisma.Decimal(source.price.amount.toJSON().amount):null,currency:source.entry.currency!,createdBy:actor.actorId,createdAt:source.now,updatedAt:source.now});
  const result=await appendServiceOrderHistory(actor,tx,order,{fromState:null,commandKey:command.idempotencyKey,commandHash:hash,reviewFingerprint:command.reviewFingerprint,reason:command.request.reason},deps);
  const final=await inspectNewServiceOrder(actor,tx,command.request);if(final.reviewFingerprint!==source.reviewFingerprint)throw new ServiceOrderConflictError();
  await repository.validateAtomicHistory();return{...result,replayed:false};
 },{timeout:120000});
}

export async function recoverServiceOrderCommand(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=serviceOrderRecoverSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ServiceOrderRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);const recorded=await repository.byNonce(input.idempotencyKey);
  if(!recorded){await serviceOrderAuthority(actor,tx,input);return{recorded:false,receipt:null};}
  if(recorded.createdBy!==actor.actorId)throw new ServiceOrderAccessError();const head=await repository.head(recorded.orderId);
  if(!head||head.propertyId!==input.propertyId||head.reservationId!==input.reservationId)throw new ServiceOrderAccessError();
  await serviceOrderAuthority(actor,tx,head);return{recorded:true,receipt:{orderId:head.id,eventId:recorded.id,version:recorded.version,state:recorded.toState}};
 },{timeout:120000});
}

export async function readServiceOrderMetadata(actor:AccountActorContext,id:string,deps:Dependencies){
 return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ServiceOrderRepository(tx,actor.organizationId),head=await repository.head(id);if(!head)throw new ServiceOrderAccessError();
  const authority=await serviceOrderAuthority(actor,tx,head),data=serviceOrderMetadata(head);await serviceOrderAuthority(actor,tx,head);
  return present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...authority.resource,data},{});
 });
}
