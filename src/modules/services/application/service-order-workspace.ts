import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {nativeServiceOrderProperty,nativeServiceOrderReservations,nativeServiceOrderReservationChoices,nativeServiceOrderReservationLabels} from "@/platform/services/order-source";
import {configurationSourceClock} from "@/platform/config/property-source";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {serviceOrderPolicyKey,serviceOrderPolicySchema} from "@/platform/config/service-order-policy";
import {configSlugSchema} from "@/platform/config/identifiers";
import {ServiceOrderRepository} from "../infrastructure/service-order-repository";
import {serviceOrderPageSchema,ServiceOrderAccessError,ServiceOrderConflictError} from "../domain/service-order";
import {serviceOrderAuthority,serviceOrderMetadataAuthority} from "./service-order-source";
import {readNativeServiceCatalog,serviceCatalogTermsSources} from "./service-catalog-source";
import {serviceCatalogSelection} from "../domain/service-catalog";
import {nativeServiceOrderTaskChoices} from "@/platform/services/order-task-write";
import {serviceOrderMetadata} from "./service-order-service";
import {inspectOriginalServiceOrder} from "./service-order-original";
import {projectServiceCatalogItem} from "./service-catalog-service";

type Dependencies={db?:TenantTransactionRunner;requestId:string};
const identity=z.object({orderId:z.uuid()}).strict(),history=identity.extend({beforeVersion:z.number().int().positive().optional()}),version=identity.extend({eventId:z.uuid()});
const reservationsInput=z.object({propertyId:z.uuid(),query:z.string().trim().max(100).default(""),after:z.uuid().optional()}).strict(),catalogInput=z.object({propertyId:z.uuid(),reservationId:z.uuid(),query:z.string().trim().max(100).default(""),after:configSlugSchema.optional()}).strict();

export async function serviceOrderPage(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=serviceOrderPageSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ServiceOrderRepository(tx,actor.organizationId),[property,stored,now]=await Promise.all([nativeServiceOrderProperty(tx,actor.organizationId,input.propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);if(!property)throw new ServiceOrderAccessError();
  const scope={organizationId:actor.organizationId,propertyId:property.id,city:property.cityId,region:property.regionId},checks=[{action:"view"as const,resource:{...scope,type:"property",id:property.id,status:property.status,occurredAt:property.createdAt}},{action:"view"as const,resource:{...scope,type:"service_order",dataClass:"operational"as const}}];assertAccountAuthorization(actor,stored,now,checks,new ServiceOrderAccessError());
  const rows=await repository.page(input),selected=rows.slice(0,20),reservations=await nativeServiceOrderReservations(tx,actor.organizationId,selected.map(row=>row.reservationId)),byId=new Map(reservations.map(row=>[row.id,row])),visible=[];
  for(const row of selected){const reservation=byId.get(row.reservationId);if(!reservation)continue;try{serviceOrderMetadataAuthority(actor,row,{property,reservation,stored,now});visible.push(row);}catch(error){if(!(error instanceof ServiceOrderAccessError))throw error;}}
  const[current,at,latestProperty,latestReservations]=await Promise.all([authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock(),nativeServiceOrderProperty(tx,actor.organizationId,input.propertyId),nativeServiceOrderReservations(tx,actor.organizationId,visible.map(row=>row.reservationId))]);assertAccountAuthorization(actor,current,at,checks,new ServiceOrderAccessError());if(!latestProperty)throw new ServiceOrderAccessError();
  const latestById=new Map(latestReservations.map(row=>[row.id,row]));for(const row of visible){const reservation=latestById.get(row.reservationId);if(!reservation)throw new ServiceOrderAccessError();serviceOrderMetadataAuthority(actor,row,{property:latestProperty,reservation,stored:current,now:at});}
  return{items:visible.map(serviceOrderMetadata),next:rows.length>20?selected.at(-1)!.id:null};
 });
}
export async function readServiceOrderOriginal(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=identity.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const source=await inspectOriginalServiceOrder(actor,tx,input.orderId);await source.recheck();return{order:serviceOrderMetadata(source.head),request:source.request,
   catalog:projectServiceCatalogItem(actor,{target:{...source.context.scope,type:"service",id:source.entry.key},now:source.authority.now},source.entry,source.terms.policies.find(row=>row.serviceKey===source.entry.key)),
   catalogRule:{id:source.root.catalogRuleId,version:source.root.catalogRuleVersion},totalAmount:source.total?.toJSON().amount??null,currency:source.root.currency,quoteReference:source.root.quoteReference,...source.request.transfer?{transferTimezone:z.object({property:z.object({timezone:z.string().min(1).max(100)})}).parse(source.root.sourceWitnesses).property.timezone}:{}};
 });
}
export async function serviceOrderTaskChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=identity.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const source=await inspectOriginalServiceOrder(actor,tx,input.orderId),result=await nativeServiceOrderTaskChoices(actor,tx,source.authority);await source.recheck();return result;});
}
export async function serviceOrderHistory(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=history.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ServiceOrderRepository(tx,actor.organizationId),head=await repository.head(input.orderId);if(!head)throw new ServiceOrderAccessError();
  await serviceOrderAuthority(actor,tx,head);const rows=await repository.historyHeads(head.id,input.beforeVersion),selected=rows.slice(0,20);await serviceOrderAuthority(actor,tx,head);
  return{items:selected.map(row=>({...row,createdAt:row.createdAt.toISOString()})),nextVersion:rows.length>20?selected.at(-1)!.version:null};
 });
}
export async function serviceOrderReservationChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=reservationsInput.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const[property,stored,now]=await Promise.all([nativeServiceOrderProperty(tx,actor.organizationId,input.propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),configurationSourceClock(tx,actor.organizationId)]);if(!property||property.archivedAt)throw new ServiceOrderAccessError();
  const scope={organizationId:actor.organizationId,propertyId:property.id,city:property.cityId,region:property.regionId},checks=[{action:"view"as const,resource:{...scope,type:"property",id:property.id}},{action:"view"as const,resource:{...scope,type:"service_order",dataClass:"operational"as const}}];assertAccountAuthorization(actor,stored,now,checks,new ServiceOrderAccessError());
  const rows=await nativeServiceOrderReservationChoices(tx,actor.organizationId,input),selected=rows.slice(0,50),allowed=selected.filter(reservation=>{try{serviceOrderMetadataAuthority(actor,{propertyId:property.id,reservationId:reservation.id},{property,reservation,stored,now});return true;}catch(error){if(error instanceof ServiceOrderAccessError)return false;throw error;}}),labels=await nativeServiceOrderReservationLabels(tx,actor.organizationId,allowed.map(row=>row.id)),names=new Map(labels.map(row=>[row.id,row.reference])),current=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),at=await configurationSourceClock(tx,actor.organizationId);
  assertAccountAuthorization(actor,current,at,checks,new ServiceOrderAccessError());for(const row of allowed)serviceOrderMetadataAuthority(actor,{propertyId:property.id,reservationId:row.id},{property,reservation:row,stored:current,now:at});
  return{items:allowed.filter(row=>names.has(row.id)).map(row=>({id:row.id,reference:names.get(row.id)!,checkIn:row.checkIn.toISOString().slice(0,10),checkOut:row.checkOut.toISOString().slice(0,10),guestCapacity:row.adultCount+row.childCount})),next:rows.length>50?selected.at(-1)!.id:null};
 });
}
export async function serviceOrderCatalogChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=catalogInput.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const authority=await serviceOrderAuthority(actor,tx,input),context=await readNativeServiceCatalog(actor,tx,{propertyId:input.propertyId,source:authority.reservation.source}),rules=new ConfigRuleRepository(tx,actor.organizationId),metadata=await rules.resolveMetadata({key:serviceOrderPolicyKey,scopes:context.scopes,asOf:context.now}),head=metadata?await rules.sourceMetadataWitness(metadata.id):null;if(!head)throw new ServiceOrderAccessError();
  assertAccountAuthorization(actor,context.stored,context.now,(["view","export"]as const).map(action=>({action,unconditional:true,resource:{...authority.scope,type:"config_rule",id:head.id,dataClass:"operational",occurredAt:head.createdAt}})),new ServiceOrderAccessError());
  const value=await rules.sourceWitness(head.id);if(!value||head.xmin!==value.xmin||head.tuple!==value.tuple)throw new ServiceOrderConflictError();const policy=serviceOrderPolicySchema.parse(value.value),{selected,next}=serviceCatalogSelection(context.catalog?.services.filter(row=>row.available===true&&row.name&&row.currency&&row.order_terms)??[],input),terms=await serviceCatalogTermsSources(actor,tx,context,selected);
  const after=await readNativeServiceCatalog(actor,tx,{propertyId:input.propertyId,source:authority.reservation.source}),latestTerms=await serviceCatalogTermsSources(actor,tx,after,selected),latestMetadata=await rules.resolveMetadata({key:serviceOrderPolicyKey,scopes:after.scopes,asOf:after.now}),latestPolicy=latestMetadata?await rules.sourceMetadataWitness(latestMetadata.id):null;
  assertAccountAuthorization(actor,after.stored,after.now,(["view","export"]as const).map(action=>({action,unconditional:true,resource:{...authority.scope,type:"config_rule",id:head.id,dataClass:"operational",occurredAt:head.createdAt}})),new ServiceOrderAccessError());
  if(context.fingerprint!==after.fingerprint||context.authorizationFingerprint!==after.authorizationFingerprint||terms.fingerprint!==latestTerms.fingerprint||head.xmin!==latestPolicy?.xmin||head.tuple!==latestPolicy.tuple)throw new ServiceOrderConflictError();
  const final=await serviceOrderAuthority(actor,tx,input);if(final.fingerprint!==authority.fingerprint)throw new ServiceOrderConflictError();return{items:selected.map(entry=>projectServiceCatalogItem(actor,after,entry,latestTerms.policies.find(row=>row.serviceKey===entry.key))),next,policy:{maxQuantity:policy.max_quantity,maxServiceDays:policy.max_service_days}};
 });
}
export async function serviceOrderHistoryOriginal(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=version.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const source=await inspectOriginalServiceOrder(actor,tx,input.orderId),row=await source.authority.repository.historyOriginal(input.eventId,input.orderId);if(!row)throw new ServiceOrderAccessError();await source.recheck();
  if(row.orderId!==source.root.id)throw new ServiceOrderConflictError();return{id:row.id,orderId:row.orderId,version:row.version,fromState:row.fromState,toState:row.toState,snapshot:row.snapshot,createdBy:row.createdBy,reason:row.reason,requestId:row.requestId,createdAt:row.createdAt.toISOString()};
 });
}
