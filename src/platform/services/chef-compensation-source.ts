import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {authorize,type Resource} from "@/platform/authz/authorize";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";
import {nativeServiceOrderProperty} from "./order-source";
/** Financial contract authority is independent of task/catalog access. Only
 * the original immutable PERSON binding selects the canonical staff profile. */
export async function nativeChefCompensationContext(actor:AccountActorContext,tx:TenantTransaction,orderId:string){
 const repository=new ServiceOrderRepository(tx,actor.organizationId);
 async function read(){const order=await repository.head(orderId);if(!order)throw new ServiceOrderAccessError();const [work,property,stored,now]=await Promise.all([repository.chefFinancialWork(order.id),nativeServiceOrderProperty(tx,actor.organizationId,order.propertyId),authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),repository.clock()]);if(!work?.chefPersonId||!property)throw new ServiceOrderSourceUnavailableError();const resource:Resource={type:"staff_compensation",organizationId:actor.organizationId,id:work.chefPersonId,assignedPersonId:work.chefPersonId,propertyId:order.propertyId,jobId:order.taskId??undefined,city:property.cityId,region:property.regionId,occurredAt:now,dataClass:"financial"};assertAccountAuthorization(actor,stored,now,[{action:"view",resource}],new ServiceOrderAccessError());const both=(action:"create"|"view",target:Resource)=>[actor.authContext,stored].every(authority=>authorize(authority,action,target,now));return{order,work,property,now,resource,canConfigure:both("create",resource),canViewPayables:both("view",{type:"employee_payable",organizationId:actor.organizationId,dataClass:"financial"}),fingerprint:commandFingerprint({order:{...order,quantity:order.quantity.toString()},work,property})};}
 const before=await read();return{...before,recheck:async()=>{const current=await read();if(current.fingerprint!==before.fingerprint||current.canConfigure!==before.canConfigure||current.canViewPayables!==before.canViewPayables)throw new ServiceOrderConflictError();return current;}};
}
