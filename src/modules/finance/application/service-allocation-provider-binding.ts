import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {serviceAllocationAuthorityChecks} from "@/platform/authz/service-allocation-resource";
import {ServiceAllocationRepository} from "../infrastructure/service-allocation-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {ServiceAllocationAccessError,ServiceAllocationSourceChangedError} from "../domain/service-allocation";
import {inspectServiceAllocationCollection,serviceCollectionSourceInput} from "./service-allocation-source";
import {inspectServiceProviderCost} from "./service-allocation-provider";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

const identity=z.uuid().transform(value=>value.toLowerCase());
export const serviceProviderBindingInput=serviceCollectionSourceInput.extend({sourceKind:z.enum(["SUPPLIER_INVOICE_LINE","EMPLOYEE_COST"]),costId:identity,operation:z.enum(["ATTACH","RELEASE"]),expectedVersion:z.number().int().min(0),idempotencyKey:identity,reason:z.string().trim().min(6).max(500)}).strict();

/** Append a versioned native-cost association; never change the cost, its payable or any journal. */
export async function changeServiceProviderBinding(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=serviceProviderBindingInput.parse(raw),requestHash=commandFingerprint({actorId:ctx.actorId,input});return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new ServiceAllocationRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await repository.lockRequest(input.idempotencyKey);
  const recovered=await repository.bindingByNonce(input.idempotencyKey);
  if(recovered){
   if(recovered.createdBy!==ctx.actorId||recovered.requestHash!==requestHash)throw new ServiceAllocationSourceChangedError();
   const root=await repository.source(recovered.sourceId);if(!root||root.cashCollectionId!==input.collectionId||root.completionEventId!==input.completionEventId)throw new ServiceAllocationAccessError();
   await recheckFinanceAuthorization(ctx,tx,await finance.clock(),serviceAllocationAuthorityChecks({type:"service_allocation",organizationId:ctx.organizationId,id:root.id,financialRecordId:root.id,propertyId:root.collection.propertyId,city:root.collection.property.cityId,region:root.collection.property.regionId,dataClass:"financial"},"view"),new ServiceAllocationAccessError());return{sourceId:root.id,bindingId:recovered.id,version:recovered.version,state:recovered.state,idempotent:true};
  }
  if(await repository.admissionByNonce(input.idempotencyKey))throw new ServiceAllocationSourceChangedError();
  const source=await inspectServiceAllocationCollection(ctx,{collectionId:input.collectionId,completionEventId:input.completionEventId},tx),collection=source.collection;
  const target={type:"service_allocation",organizationId:ctx.organizationId,propertyId:collection.propertyId,city:collection.property.cityId,region:collection.property.regionId,dataClass:"financial"as const,amount:source.amount.toJSON().amount,occurredAt:source.task.completedAt!};
  const recheckAuthority=async()=>recheckFinanceAuthorization(ctx,tx,await finance.clock(),serviceAllocationAuthorityChecks(target,"edit"),new ServiceAllocationAccessError());await recheckAuthority();
  const native=input.operation==="ATTACH"?await inspectServiceProviderCost(ctx,input.sourceKind,input.costId,tx):null;
  if(native&&(native.amount.currency!==collection.currency||native.propertyId&&native.propertyId!==collection.propertyId||native.reservationId&&native.reservationId!==collection.reservationId))throw new ServiceAllocationSourceChangedError();
  await repository.lockProvider(input.sourceKind,input.costId);await repository.lockCollection(collection.id);
  const previous=await repository.latestBinding(input.sourceKind,input.costId),existingRoot=await repository.sourceForCollection(collection.id);
  if((previous?.version??0)!==input.expectedVersion||input.operation==="ATTACH"&&previous?.state==="ATTACHED"||input.operation==="RELEASE"&&(!previous||previous.state!=="ATTACHED"||previous.sourceId!==existingRoot?.id))throw new ServiceAllocationSourceChangedError();
  const now=await finance.clock(),root=existingRoot??await repository.registerSource({sourceKind:"COMPLETED_SERVICE_COLLECTION",cashCollectionId:collection.id,completionEventId:input.completionEventId,createdBy:ctx.actorId,createdAt:now});if(root.completionEventId!==input.completionEventId)throw new ServiceAllocationSourceChangedError();
  if(!existingRoot)await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,resourceType:"service_allocation",resourceId:root.id,propertyScopeId:collection.propertyId,action:"service_allocation.source_registered",after:{sourceId:root.id,collectionId:collection.id,completionEventId:input.completionEventId},requestId:deps.requestId??randomUUID(),occurredAt:now});
  const row=await repository.appendBinding({sourceId:root.id,supplierInvoiceLineId:input.sourceKind==="SUPPLIER_INVOICE_LINE"?input.costId:null,employeeCostId:input.sourceKind==="EMPLOYEE_COST"?input.costId:null,version:(previous?.version??0)+1,previousBindingId:previous?.id??null,idempotencyKey:input.idempotencyKey,requestHash,state:input.operation==="ATTACH"?"ATTACHED":"RELEASED",reason:input.reason,createdBy:ctx.actorId,createdAt:now});
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,resourceType:"service_allocation",resourceId:root.id,propertyScopeId:collection.propertyId,action:row.state==="ATTACHED"?"service_allocation.provider_attached":"service_allocation.provider_released",before:previous?{bindingId:previous.id,sourceId:previous.sourceId,version:previous.version,state:previous.state}:null,after:{bindingId:row.id,sourceId:root.id,version:row.version,idempotencyKey:row.idempotencyKey,requestHash,state:row.state},reason:row.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});
  await source.recheckSource();if(native)await native.recheck();await recheckAuthority();await repository.flushGuards();await source.recheckSource();if(native)await native.recheck();await recheckAuthority();return{sourceId:root.id,bindingId:row.id,version:row.version,state:row.state,idempotent:false};
 },{timeout:120000});
}
