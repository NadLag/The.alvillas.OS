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
type Head=NonNullable<Awaited<ReturnType<ServiceOrderRepository["head"]>>>;
async function inspectFinancialHead(actor:AccountActorContext,tx:TenantTransaction,head:Head,mode:"admission"|"history",source?:{taskId:string;propertyId:string;reservationId:string|null}){
 const repository=new ServiceOrderRepository(tx,actor.organizationId);
 async function inspect(){
  const current=await repository.head(head.id);if(!current||source&&(current.taskId!==source.taskId||current.propertyId!==source.propertyId||current.reservationId!==source.reservationId)||mode==="admission"&&!["CONFIRMED","IN_PROGRESS","FULFILLED"].includes(current.state))throw new ServiceAllocationSourceUnavailableError();
  const[property,stored,now]=await Promise.all([nativeServiceOrderProperty(tx,actor.organizationId,current.propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);if(!property||mode==="admission"&&property.archivedAt)throw new ServiceAllocationSourceUnavailableError();
  const resource={type:"service_order",id:current.id,organizationId:actor.organizationId,propertyId:current.propertyId,reservationId:current.reservationId,serviceId:current.serviceKey,city:property.cityId,region:property.regionId,status:current.state,occurredAt:current.createdAt,dataClass:"financial"as const};assertAccountAuthorization(actor,stored,now,[{action:"view",resource,unconditional:true}],new ServiceAllocationAccessError());
  return{head:current,scope:{city:property.cityId,region:property.regionId,archivedAt:property.archivedAt},authority:commandFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(stored)})};
 }
 const witness=(value:Awaited<ReturnType<typeof inspect>>)=>commandFingerprint({head:serviceOrderMetadata(value.head),scope:value.scope,authority:value.authority}),original=await inspect(),fingerprint=witness(original);
 return{head:original.head,fingerprint,recheck:async()=>{if(witness(await inspect())!==fingerprint)throw new ServiceAllocationSourceChangedError();}};
}
export async function inspectNativeServiceOrderFinancialHead(actor:AccountActorContext,tx:TenantTransaction,orderId:string){const head=await new ServiceOrderRepository(tx,actor.organizationId).head(orderId);if(!head)throw new ServiceAllocationAccessError();return inspectFinancialHead(actor,tx,head,"history");}
export async function inspectNativeServiceOrderFinancialIdentity(actor:AccountActorContext,tx:TenantTransaction,source:{taskId:string;propertyId:string;reservationId:string|null},mode:"admission"|"history"="admission"){
 const head=await new ServiceOrderRepository(tx,actor.organizationId).byTaskHead(source.taskId);if(!head)return null;const authority=await inspectFinancialHead(actor,tx,head,mode,source);return{orderId:authority.head.id,serviceKey:authority.head.serviceKey,taskId:authority.head.taskId,propertyId:authority.head.propertyId,reservationId:authority.head.reservationId,fingerprint:authority.fingerprint,recheck:authority.recheck};
}
