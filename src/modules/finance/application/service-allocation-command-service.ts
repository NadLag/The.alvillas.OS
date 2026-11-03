import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner,type TenantTransaction} from "@/platform/db/tenant";
import {serviceAllocationAuthorityChecks} from "@/platform/authz/service-allocation-resource";
import {serviceAllocationCommandSchema,serviceAllocationCommandSuccessSchema,serviceAllocationCommandResultSchema,serviceAllocationCommandRecoverySchema} from "../domain/service-allocation-command";
import {ServiceAllocationAccessError,ServiceAllocationSourceChangedError,ServiceAllocationSourceUnavailableError,ServiceAllocationConfigurationError} from "../domain/service-allocation";
import {AccountingPeriodClosedError} from "../domain/accounting-period";
import {ServiceAllocationRepository} from "../infrastructure/service-allocation-repository";
import {ServiceAllocationPostingRepository} from "../infrastructure/service-allocation-posting-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
import {admitServiceAllocation} from "./service-allocation-admission";
import {changeServiceProviderBinding} from "./service-allocation-provider-binding";
import {recognizeServiceAllocation,reverseServiceAllocation} from "./service-allocation-recognition";

type Deps={db?:TenantTransactionRunner;requestId?:string};
/** A receipt is read only after all independent current private-source grants have been repeated. */
export async function recheckServiceAllocationRead(ctx:FinanceActorContext,tx:TenantTransaction,sourceId:string){
 const root=await new ServiceAllocationRepository(tx,ctx.organizationId).source(sourceId);if(!root)throw new ServiceAllocationAccessError();
 await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),serviceAllocationAuthorityChecks({type:"service_allocation",organizationId:ctx.organizationId,id:root.id,financialRecordId:root.id,propertyId:root.collection.propertyId,reservationId:root.collection.reservationId,jobId:root.collection.taskId,city:root.collection.property.cityId,region:root.collection.property.regionId,dataClass:"financial",amount:root.collection.amount.toFixed(2),occurredAt:root.collection.recordedAt}),new ServiceAllocationAccessError());return root;
}

/** Execution uses the existing atomic native acknowledgements, without a second command ledger. */
export async function executeServiceAllocationCommand(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const command=serviceAllocationCommandSchema.parse(raw),input={...command.input,idempotencyKey:command.idempotencyKey};
 const result=command.operation==="BIND"?await changeServiceProviderBinding(ctx,input,deps):command.operation==="ADMIT"?await admitServiceAllocation(ctx,input,deps):command.operation==="RECOGNIZE"?await recognizeServiceAllocation(ctx,input,deps):await reverseServiceAllocation(ctx,input,deps);
 return serviceAllocationCommandSuccessSchema.parse({requestId:command.idempotencyKey,idempotencyKey:command.idempotencyKey,operation:command.operation,state:"SUCCEEDED",failureCode:null,sourceId:result.sourceId,resultId:"bindingId"in result?result.bindingId:"admissionId"in result?result.admissionId:result.postingId,version:result.version,idempotent:result.idempotent});
}

/** The original command lock makes absence authoritative even when its HTTP acknowledgement was lost. */
export async function recoverServiceAllocationCommand(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=serviceAllocationCommandRecoverySchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new ServiceAllocationRepository(tx,ctx.organizationId);await repository.lockRequest(input.key);
  const posting=await new ServiceAllocationPostingRepository(tx,ctx.organizationId).byNonce(input.key),admission=posting?null:await repository.admissionByNonce(input.key),binding=posting||admission?null:await repository.bindingByNonce(input.key),row=posting??admission??binding;
  if(!row){await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),serviceAllocationAuthorityChecks({type:"service_allocation",organizationId:ctx.organizationId,dataClass:"financial"}),new ServiceAllocationAccessError());return{request:null};}
  if(row.createdBy!==ctx.actorId)throw new ServiceAllocationAccessError();await recheckServiceAllocationRead(ctx,tx,row.sourceId);
  const request=serviceAllocationCommandSuccessSchema.parse({requestId:input.key,idempotencyKey:input.key,operation:posting?(posting.kind==="RECOGNITION"?"RECOGNIZE":"REVERSE"):admission?"ADMIT":"BIND",state:"SUCCEEDED",failureCode:null,sourceId:row.sourceId,resultId:row.id,version:row.version,idempotent:true});await recheckServiceAllocationRead(ctx,tx,row.sourceId);return{request};
 },{timeout:120000});
}

/** Report known rejections only after the native transaction has rolled back. Unknown outcomes require recovery. */
export async function requestServiceAllocationCommand(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const command=serviceAllocationCommandSchema.parse(raw);try{return await executeServiceAllocationCommand(ctx,command,deps);}catch(error){
  const base={requestId:deps.requestId??randomUUID(),idempotencyKey:command.idempotencyKey,operation:command.operation};
  if(error instanceof ServiceAllocationSourceChangedError)return serviceAllocationCommandResultSchema.parse({...base,state:"CONFLICT",failureCode:"SOURCE_CHANGED"});
  const failureCode=error instanceof ServiceAllocationConfigurationError?"CONFIGURATION_UNAVAILABLE":error instanceof ServiceAllocationSourceUnavailableError?"SOURCE_UNAVAILABLE":error instanceof AccountingPeriodClosedError?"PERIOD_CLOSED":null;
  if(failureCode)return serviceAllocationCommandResultSchema.parse({...base,state:"FAILED",failureCode});throw error;
 }
}
