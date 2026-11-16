import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {serviceOrderMetadata} from "@/modules/services/application/service-order-service";
import {nativeServiceOrderProperty} from "./order-source";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {ServiceAllocationAccessError,ServiceAllocationSourceChangedError,ServiceAllocationSourceUnavailableError} from "@/modules/finance/domain/service-allocation";

/** The unique canonical task is the order's existing financial source identity.
 * Read only operational heads here; native financial inspectors retain control
 * of actual collected money, recognized costs, compensation and journals. */
export async function inspectNativeServiceOrderFinancialIdentity(actor:AccountActorContext,tx:TenantTransaction,source:{taskId:string;propertyId:string;reservationId:string|null},mode:"admission"|"history"="admission"){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),selected=await repository.byTaskHead(source.taskId);if(!selected)return null;const head=selected;
 async function inspect(){
  const current=await repository.byTaskHead(source.taskId);if(!current||current.id!==head.id||current.propertyId!==source.propertyId||current.reservationId!==source.reservationId||mode==="admission"&&!["CONFIRMED","IN_PROGRESS","FULFILLED"].includes(current.state))throw new ServiceAllocationSourceUnavailableError();
  const[property,stored,now]=await Promise.all([nativeServiceOrderProperty(tx,actor.organizationId,current.propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);if(!property||mode==="admission"&&property.archivedAt)throw new ServiceAllocationSourceUnavailableError();
  const resource={type:"service_order",id:current.id,organizationId:actor.organizationId,propertyId:current.propertyId,reservationId:current.reservationId,serviceId:current.serviceKey,city:property.cityId,region:property.regionId,status:current.state,occurredAt:current.createdAt,dataClass:"financial"as const};assertAccountAuthorization(actor,stored,now,[{action:"view",resource,unconditional:true}],new ServiceAllocationAccessError());
  return{head:current,scope:{city:property.cityId,region:property.regionId,archivedAt:property.archivedAt},authority:commandFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)})};
 }
 const witness=(value:Awaited<ReturnType<typeof inspect>>)=>commandFingerprint({head:serviceOrderMetadata(value.head),scope:value.scope,authority:value.authority}),original=await inspect(),identity={orderId:original.head.id,serviceKey:original.head.serviceKey,taskId:original.head.taskId,propertyId:original.head.propertyId,reservationId:original.head.reservationId},fingerprint=witness(original);
 return{...identity,fingerprint,recheck:async()=>{if(witness(await inspect())!==fingerprint)throw new ServiceAllocationSourceChangedError();}};
}
