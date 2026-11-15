import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {serviceOrderAuthority} from "@/modules/services/application/service-order-source";
import {serviceOrderMetadata} from "@/modules/services/application/service-order-service";
import {ServiceOrderAccessError} from "@/modules/services/domain/service-order";
import {ServiceAllocationAccessError,ServiceAllocationSourceChangedError,ServiceAllocationSourceUnavailableError} from "@/modules/finance/domain/service-allocation";

/** The unique canonical task is the order's existing financial source identity.
 * Read only operational heads here; native financial inspectors retain control
 * of actual collected money, recognized costs, compensation and journals. */
export async function inspectNativeServiceOrderFinancialIdentity(actor:AccountActorContext,tx:TenantTransaction,source:{taskId:string;propertyId:string;reservationId:string|null}){
 const repository=new ServiceOrderRepository(tx,actor.organizationId),selected=await repository.byTaskHead(source.taskId);if(!selected)return null;const head=selected;
 async function inspect(){
  const current=await repository.byTaskHead(source.taskId);if(!current||current.id!==head.id||current.propertyId!==source.propertyId||current.reservationId!==source.reservationId||!["CONFIRMED","IN_PROGRESS","FULFILLED"].includes(current.state))throw new ServiceAllocationSourceUnavailableError();
  try{const authority=await serviceOrderAuthority(actor,tx,current);return{head:current,authority};}catch(error){if(error instanceof ServiceOrderAccessError)throw new ServiceAllocationAccessError();throw error;}
 }
 const original=await inspect(),identity={orderId:original.head.id,serviceKey:original.head.serviceKey,taskId:original.head.taskId,propertyId:original.head.propertyId,reservationId:original.head.reservationId},fingerprint=commandFingerprint({head:serviceOrderMetadata(original.head),authority:original.authority.fingerprint});
 return{...identity,fingerprint,recheck:async()=>{const after=await inspect();if(commandFingerprint({head:serviceOrderMetadata(after.head),authority:after.authority.fingerprint})!==fingerprint)throw new ServiceAllocationSourceChangedError();}};
}
