import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {serviceAllocationPolicyKey,serviceAllocationPolicySchema} from "@/platform/config/service-allocation-policy";
import {serviceAllocationAuthorityChecks} from "@/platform/authz/service-allocation-resource";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ServiceAllocationAccessError,ServiceAllocationSourceChangedError,ServiceAllocationConfigurationError} from "../domain/service-allocation";
import {buildServiceAllocationSnapshot,serviceAllocationOwnerSchema} from "../domain/service-allocation-snapshot";
import {ServiceAllocationRepository} from "../infrastructure/service-allocation-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {inspectServiceAllocationCollection,serviceCollectionSourceInput} from "./service-allocation-source";
import {inspectServiceProviderCost,serviceProviderLockIdentity} from "./service-allocation-provider";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

const identity=z.uuid().transform(value=>value.toLowerCase()),selection=z.object({componentKey:z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u),bindingId:identity}).strict();
export const serviceAllocationReviewInput=serviceCollectionSourceInput.extend({serviceKey:z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u),providers:z.array(selection).max(100)}).strict();
export const serviceAllocationAdmissionInput=serviceAllocationReviewInput.extend({expectedVersion:z.number().int().min(0),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),idempotencyKey:identity,reason:z.string().trim().min(6).max(500)}).strict();
type Deps={db?:TenantTransactionRunner;requestId?:string};

async function prepare(ctx:FinanceActorContext,input:z.infer<typeof serviceAllocationReviewInput>,tx:TenantTransaction,action:"view"|"create"){
 const repository=new ServiceAllocationRepository(tx,ctx.organizationId),source=await inspectServiceAllocationCollection(ctx,{collectionId:input.collectionId,completionEventId:input.completionEventId},tx),collection=source.collection;
 const target={type:"service_allocation",organizationId:ctx.organizationId,propertyId:collection.propertyId,reservationId:collection.reservationId,jobId:collection.taskId,city:collection.property.cityId,region:collection.property.regionId,amount:source.amount.toJSON().amount,occurredAt:source.task.completedAt!,dataClass:"financial"as const};
 const recheckAuthority=async()=>recheckFinanceAuthorization(ctx,tx,await source.finance.clock(),serviceAllocationAuthorityChecks(target,action),new ServiceAllocationAccessError());await recheckAuthority();
 if(new Set(input.providers.map(row=>row.componentKey)).size!==input.providers.length||new Set(input.providers.map(row=>row.bindingId)).size!==input.providers.length)throw new ServiceAllocationConfigurationError();
 const bindings=await repository.bindings(input.providers.map(row=>row.bindingId)),root=await repository.sourceForCollection(collection.id);
 if(bindings.length!==input.providers.length||bindings.some(row=>row.sourceId!==root?.id||row.state!=="ATTACHED"))throw new ServiceAllocationAccessError();
 // Native supplier invoices precede native employee claims; both precede our provider and collection locks.
 const ordered=[];for(const binding of bindings)ordered.push({binding,key:await serviceProviderLockIdentity(ctx,binding.supplierInvoiceLineId?"SUPPLIER_INVOICE_LINE":"EMPLOYEE_COST",binding.supplierInvoiceLineId??binding.employeeCostId!,tx)});
 const providers:Array<{binding:typeof bindings[number];cost:Awaited<ReturnType<typeof inspectServiceProviderCost>>}>=[];for(const {binding} of ordered.sort((a,b)=>a.key.localeCompare(b.key))){
  const kind=binding.supplierInvoiceLineId?"SUPPLIER_INVOICE_LINE"as const:"EMPLOYEE_COST"as const,costId=binding.supplierInvoiceLineId??binding.employeeCostId!,cost=await inspectServiceProviderCost(ctx,kind,costId,tx);
  if(cost.amount.currency!==collection.currency||cost.propertyId&&cost.propertyId!==collection.propertyId||cost.reservationId&&cost.reservationId!==collection.reservationId)throw new ServiceAllocationSourceChangedError();
  await repository.lockProvider(kind,costId);const current=await repository.latestBinding(kind,costId);if(current?.id!==binding.id)throw new ServiceAllocationSourceChangedError();providers.push({binding,cost});
 }
 await repository.lockCollection(collection.id);
 const scopes=[{scopeType:"property",scopeId:collection.propertyId},{scopeType:"organization",scopeId:null}],at=source.task.completedAt!;
 const build=async()=>{
  const config=await new ConfigRuleRepository(tx,ctx.organizationId).scopedSnapshot(scopes,at),allocationRule=config.resolve(serviceAllocationPolicyKey),taxRule=config.resolve("finance.tax");if(!allocationRule||!taxRule)throw new ServiceAllocationConfigurationError();
  const policy=serviceAllocationPolicySchema.parse(allocationRule.value);let owners:z.infer<typeof serviceAllocationOwnerSchema>[];
  if(policy.ownership_basis==="RESERVATION_SNAPSHOT")owners=z.object({reservationFinancialSnapshot:z.object({rules:z.object({owners:z.array(serviceAllocationOwnerSchema)})})}).parse(collection.provenance).reservationFinancialSnapshot.rules.owners;
  else owners=(await repository.propertyOwners(collection.propertyId)).map(row=>({ownerId:row.ownerId,ownerName:row.owner.displayName,shareBps:row.shareBps}));
  return buildServiceAllocationSnapshot({source:{kind:"COMPLETED_SERVICE_COLLECTION",collectionId:collection.id,transactionId:collection.transactionId,taskId:collection.taskId,propertyId:collection.propertyId,reservationId:collection.reservationId,completionEventId:source.completed.event.id,performedByPersonId:source.task.completedByPersonId!,completedAt:at.toISOString(),recordedAt:collection.recordedAt.toISOString(),currencyMinorUnit:collection.currencyRef.minorUnit},gross:source.amount,serviceKey:input.serviceKey,allocationRule,taxRule,owners,providerCosts:providers.map(({binding,cost})=>({...cost,bindingId:binding.id,componentKey:input.providers.find(row=>row.bindingId===binding.id)!.componentKey}))});
 };
 const prepared=await build(),recheck=async()=>{await source.recheckSource();for(const provider of providers)await provider.cost.recheck();if((await build()).fingerprint!==prepared.fingerprint)throw new ServiceAllocationSourceChangedError();await recheckAuthority();};await recheck();
 return{repository,source,root,...prepared,recheck,target};
}

/** A read-only review of actual completed work, selected policy, existing costs and exact entitlements. */
export async function reviewServiceAllocation(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=serviceAllocationReviewInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const prepared=await prepare(ctx,input,tx,"view"),current=prepared.root?await prepared.repository.latestAdmission(prepared.root.id):null,data={sourceId:prepared.root?.id??null,version:current?.version??0,reviewFingerprint:prepared.fingerprint,snapshot:prepared.snapshot};
  const result=present({...ctx.authContext,visibleDataClasses:new Set(["financial"as const])},"view",{...prepared.target,data},catalogFieldPolicy<typeof data>("service_allocation"),await prepared.source.finance.clock());
  await prepared.recheck();if(result.version===undefined||!result.reviewFingerprint||!result.snapshot)throw new ServiceAllocationAccessError();return{sourceId:result.sourceId??null,version:result.version,reviewFingerprint:result.reviewFingerprint,snapshot:result.snapshot};
 },{timeout:120000});
}

/** Persist a consecutive reviewed decision and native provider references; collected cash and existing payables stay unchanged. */
export async function admitServiceAllocation(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=serviceAllocationAdmissionInput.parse(raw),requestHash=commandFingerprint({actorId:ctx.actorId,input});return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new ServiceAllocationRepository(tx,ctx.organizationId);await repository.lockRequest(input.idempotencyKey);
  const recovered=await repository.admissionByNonce(input.idempotencyKey);
  if(recovered){
   if(recovered.requestHash!==requestHash||recovered.createdBy!==ctx.actorId||recovered.source.cashCollectionId!==input.collectionId||recovered.source.completionEventId!==input.completionEventId)throw new ServiceAllocationSourceChangedError();
   const root=await repository.source(recovered.sourceId);if(!root)throw new ServiceAllocationAccessError();const target={type:"service_allocation",organizationId:ctx.organizationId,id:root.id,financialRecordId:root.id,propertyId:root.collection.propertyId,city:root.collection.property.cityId,region:root.collection.property.regionId,dataClass:"financial"as const,amount:root.collection.amount.toFixed(2),occurredAt:recovered.createdAt};
   await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),serviceAllocationAuthorityChecks(target,"view"),new ServiceAllocationAccessError());return{sourceId:root.id,admissionId:recovered.id,version:recovered.version,idempotent:true};
  }
  if(await repository.bindingByNonce(input.idempotencyKey))throw new ServiceAllocationSourceChangedError();
  const prepared=await prepare(ctx,serviceAllocationReviewInput.parse({collectionId:input.collectionId,completionEventId:input.completionEventId,serviceKey:input.serviceKey,providers:input.providers}),tx,"create"),existingRoot=await repository.sourceForCollection(input.collectionId),previous=existingRoot?await repository.latestAdmission(existingRoot.id):null;
  if((previous?.version??0)!==input.expectedVersion||prepared.fingerprint!==input.reviewFingerprint)throw new ServiceAllocationSourceChangedError();
  const now=await prepared.source.finance.clock(),root=existingRoot??await repository.registerSource({sourceKind:"COMPLETED_SERVICE_COLLECTION",cashCollectionId:input.collectionId,completionEventId:input.completionEventId,createdBy:ctx.actorId,createdAt:now});
  if(root.completionEventId!==input.completionEventId)throw new ServiceAllocationSourceChangedError();
  if(!existingRoot)await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,resourceType:"service_allocation",resourceId:root.id,propertyScopeId:prepared.source.collection.propertyId,action:"service_allocation.source_registered",after:{sourceId:root.id,collectionId:input.collectionId,completionEventId:input.completionEventId},requestId:deps.requestId??randomUUID(),occurredAt:now});
  const row=await repository.appendAdmission({sourceId:root.id,version:(previous?.version??0)+1,previousAdmissionId:previous?.id??null,idempotencyKey:input.idempotencyKey,requestHash,reviewFingerprint:input.reviewFingerprint,allocationRuleId:prepared.snapshot.rules.allocation.id,taxRuleId:prepared.snapshot.rules.tax.id,serviceKey:input.serviceKey,snapshot:prepared.snapshot,reason:input.reason,createdBy:ctx.actorId,createdAt:now});
  for(const cost of prepared.snapshot.providerCosts)await repository.appendProviderPart({admissionId:row.id,bindingId:cost.bindingId,componentKey:cost.componentKey});
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,resourceType:"service_allocation",resourceId:root.id,propertyScopeId:prepared.source.collection.propertyId,action:"service_allocation.admitted",before:previous?{admissionId:previous.id,version:previous.version}:null,after:{sourceId:root.id,admissionId:row.id,version:row.version,idempotencyKey:row.idempotencyKey,requestHash,reviewFingerprint:row.reviewFingerprint},reason:row.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});
  await prepared.recheck();await repository.flushGuards();await prepared.recheck();return{sourceId:root.id,admissionId:row.id,version:row.version,idempotent:false};
 },{timeout:120000});
}
