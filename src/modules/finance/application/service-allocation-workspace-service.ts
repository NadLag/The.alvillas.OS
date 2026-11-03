import type {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner,type TenantTransaction} from "@/platform/db/tenant";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import type {Resource} from "@/platform/authz/authorize";
import {serviceAllocationAuthorityChecks} from "@/platform/authz/service-allocation-resource";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {serviceAllocationPolicyKey,serviceAllocationPolicySchema} from "@/platform/config/service-allocation-policy";
import {ServiceAllocationAccessError,ServiceAllocationSourceUnavailableError,ServiceAllocationConfigurationError} from "../domain/service-allocation";
import {readServiceAllocationSnapshot} from "../domain/service-allocation-snapshot";
import {serviceAllocationWorkspaceReadSchema,serviceAllocationCollectionsSchema,serviceAllocationCollectionSchema,serviceAllocationDetailSchema,serviceAllocationProvidersSchema,serviceAllocationReviewSchema} from "../domain/service-allocation-workspace";
import {ServiceAllocationWorkspaceRepository} from "../infrastructure/service-allocation-workspace-repository";
import {ServiceAllocationPostingRepository} from "../infrastructure/service-allocation-posting-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {AccountingPeriodRepository} from "../infrastructure/accounting-period-repository";
import {recheckServiceAllocationRead} from "./service-allocation-command-service";
import {inspectServiceAllocationCollection} from "./service-allocation-source";
import {inspectServiceProviderCost,serviceProviderLockIdentity} from "./service-allocation-provider";
import {reviewServiceAllocation} from "./service-allocation-admission";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
async function readAuthority(ctx:FinanceActorContext,tx:TenantTransaction,target:Resource){await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),serviceAllocationAuthorityChecks(target),new ServiceAllocationAccessError());}
async function disclose<T extends Record<string,unknown>>(ctx:FinanceActorContext,tx:TenantTransaction,target:Resource,value:T){
 await readAuthority(ctx,tx,target);const data={snapshot:value},result=present({...ctx.authContext,visibleDataClasses:new Set(["financial"as const])},"view",{...target,data},catalogFieldPolicy<typeof data>("service_allocation"),await new FinanceRepository(tx,ctx.organizationId).clock());await readAuthority(ctx,tx,target);if(result.snapshot!==value)throw new ServiceAllocationAccessError();return value;
}
async function capabilities(ctx:FinanceActorContext,tx:TenantTransaction,target:Resource,at:Date,active?:{id:string;transactionId:string;transaction:{occurredAt:Date}}|null){
 const now=await new FinanceRepository(tx,ctx.organizationId).clock(),allowed=async(action:"create"|"edit"|"pay"|"void"|"override",dates:Date[],journalId?:string,createJournal=false)=>{
  try{for(const occurredAt of dates){const resource={...target,occurredAt};await recheckFinanceAuthorization(ctx,tx,now,[...serviceAllocationAuthorityChecks(resource,action),...action==="pay"||action==="void"||action==="override"?[{action,resource:{...resource,type:"financial_transaction",id:journalId,financialRecordId:journalId}}]:[],...createJournal?[{action:"create"as const,resource:{...resource,type:"financial_transaction",id:undefined,financialRecordId:undefined}}]:[]],new ServiceAllocationAccessError());}return true;}catch(error){if(error instanceof ServiceAllocationAccessError)return false;throw error;}
 },open=await new AccountingPeriodRepository(tx,ctx.organizationId).postingOpen(at);
 return{admit:await allowed("create",[at]),bind:await allowed("edit",[at]),recognize:open&&await allowed("pay",[at],undefined,true),adjust:!open&&await allowed("pay",[at])&&await allowed("pay",[now],undefined,true)&&await allowed("override",[at,now]),reverse:!!active&&await allowed("void",[active.transaction.occurredAt],active.transactionId)&&await allowed("void",[now],active.transactionId,true)};
}

/** Private reads use original admissions and native journals, including history after source corrections. */
export async function readServiceAllocationWorkspace(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=serviceAllocationWorkspaceReadSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new ServiceAllocationWorkspaceRepository(tx,ctx.organizationId),native={db:repository.runner(),requestId:deps.requestId};
  if(input.operation==="REVIEW"){const {operation,...selection}=input;void operation;return serviceAllocationReviewSchema.parse(await reviewServiceAllocation(ctx,selection,native));}
  if(input.operation==="DETAIL"){
   const root=await recheckServiceAllocationRead(ctx,tx,input.sourceId),target={type:"service_allocation",organizationId:ctx.organizationId,id:root.id,financialRecordId:root.id,propertyId:root.collection.propertyId,city:root.collection.property.cityId,region:root.collection.property.regionId,dataClass:"financial"as const},postings=new ServiceAllocationPostingRepository(tx,ctx.organizationId);
   const admissions=await repository.admissionHistory(root.id,input.beforeAdmissionVersion),bindings=await repository.bindingHistory(root.id,input.beforeBinding),journals=await postings.history(root.id,input.beforePostingVersion),latestAdmission=await repository.latestAdmission(root.id),latestPosting=await postings.latest(root.id),active=await postings.activeRecognition(root.id),bindingFacts=[];
   for(const row of bindings.slice(0,50)){const kind=row.supplierInvoiceLineId?"SUPPLIER_INVOICE_LINE"as const:"EMPLOYEE_COST"as const,costId=row.supplierInvoiceLineId??row.employeeCostId!;bindingFacts.push({id:row.id,costId,kind,version:row.version,state:row.state,reason:row.reason,at:row.createdAt.toISOString(),current:(await repository.latestBinding(kind,costId))?.id===row.id});}
   const result=serviceAllocationDetailSchema.parse({sourceId:root.id,collectionId:root.cashCollectionId,completionEventId:root.completionEventId,capabilities:await capabilities(ctx,tx,target,latestAdmission?new Date(readServiceAllocationSnapshot(latestAdmission.snapshot).snapshot.source.completedAt):root.collection.recordedAt,active),
    admissions:admissions.slice(0,50).map(row=>({id:row.id,version:row.version,reason:row.reason,at:row.createdAt.toISOString(),snapshot:readServiceAllocationSnapshot(row.snapshot).snapshot})),admissionsNext:admissions.length>50?admissions[49].version:null,
    bindings:bindingFacts,bindingsNext:bindings.length>50?bindings[49].id:null,
    postings:journals.slice(0,50).map(row=>({id:row.id,admissionId:row.admissionId,transactionId:row.transactionId,version:row.version,kind:row.kind,reason:row.reason,at:row.createdAt.toISOString(),occurredAt:row.transaction.occurredAt.toISOString(),reversesPostingId:row.reversesPostingId,adjustment:row.periodAdjustment?{periodId:row.periodAdjustment.periodId,periodEventId:row.periodAdjustment.periodEventId,sourceOccurredAt:row.periodAdjustment.sourceOccurredAt.toISOString()}:null,lines:row.transaction.postings.map(line=>({account:line.ledgerAccount.code,ownerName:readServiceAllocationSnapshot(row.admission.snapshot).snapshot.owners.find(owner=>owner.ownerId===(line.dimensions as Record<string,unknown>).owner_id)?.ownerName??null,side:line.side,amount:{amount:line.amount.toFixed(2),currency:line.currency},bucket:line.bucket,dimensions:line.dimensions}))})),postingsNext:journals.length>50?journals[49].version:null,
    latestAdmissionId:latestAdmission?.id??null,latestAdmissionVersion:latestAdmission?.version??0,latestPostingVersion:latestPosting?.version??0,activePostingId:active?.id??null});
   await recheckServiceAllocationRead(ctx,tx,root.id);return disclose(ctx,tx,target,result);
  }
  if(input.operation==="COLLECTIONS"){
   const property=input.propertyId?await repository.property(input.propertyId):null;if(input.propertyId&&(!property||property.archivedAt))throw new ServiceAllocationAccessError();const target={type:"service_allocation",organizationId:ctx.organizationId,dataClass:"financial"as const,propertyId:property?.id,city:property?.cityId,region:property?.regionId};await readAuthority(ctx,tx,target);
   const scanned=await repository.collections(input),items: z.infer<typeof serviceAllocationCollectionsSchema>["items"]=[],sources=[];
   for(const row of scanned.slice(0,50)){try{const source=await inspectServiceAllocationCollection(ctx,{collectionId:row.id,completionEventId:row.completionEventId},tx),property=await repository.property(source.collection.propertyId);if(!property)throw new ServiceAllocationAccessError();sources.push(source);items.push({collectionId:row.id,completionEventId:row.completionEventId,sourceId:(await repository.sourceForCollection(row.id))?.id??null,propertyId:property.id,propertyName:property.name,purpose:source.collection.purpose,completedAt:source.task.completedAt!.toISOString(),amount:source.amount.toJSON()});}catch(error){if(error instanceof ServiceAllocationSourceUnavailableError)continue;throw error;}}
   for(const source of sources)await source.recheckSource();return disclose(ctx,tx,target,serviceAllocationCollectionsSchema.parse({items,next:scanned.length>50?scanned[49].id:null}));
  }
  const source=await inspectServiceAllocationCollection(ctx,{collectionId:input.collectionId,completionEventId:input.completionEventId},tx),collection=source.collection,property=await repository.property(collection.propertyId);if(!property)throw new ServiceAllocationAccessError();const target={type:"service_allocation",organizationId:ctx.organizationId,propertyId:property.id,city:property.cityId,region:property.regionId,dataClass:"financial"as const};await readAuthority(ctx,tx,target);
  if(input.operation==="COLLECTION"){
   const rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:serviceAllocationPolicyKey,scopes:[{scopeType:"property",scopeId:property.id},{scopeType:"organization",scopeId:null}],asOf:source.task.completedAt!});if(!rule)throw new ServiceAllocationConfigurationError();const policy=serviceAllocationPolicySchema.parse(rule.value),result=serviceAllocationCollectionSchema.parse({collectionId:collection.id,completionEventId:source.completed.event.id,sourceId:(await repository.sourceForCollection(collection.id))?.id??null,propertyId:property.id,propertyName:property.name,purpose:collection.purpose,completedAt:source.task.completedAt!.toISOString(),amount:source.amount.toJSON(),capabilities:await capabilities(ctx,tx,target,source.task.completedAt!),services:policy.services.filter(row=>row.currency===collection.currency).map(row=>({key:row.service_key,currency:row.currency,providers:row.components.filter(component=>component.beneficiary==="SUPPLIER"||component.beneficiary==="PERSON").map(component=>({key:component.key,kind:component.beneficiary==="SUPPLIER"?"SUPPLIER_INVOICE_LINE":"EMPLOYEE_COST"}))}))});await source.recheckSource();return disclose(ctx,tx,target,result);
  }
  const scanned=await repository.providers(input.kind,collection,input.after),ordered=[];for(const row of scanned.slice(0,50))ordered.push({id:row.id,key:await serviceProviderLockIdentity(ctx,input.kind,row.id,tx)});
  const items:z.infer<typeof serviceAllocationProvidersSchema>["items"]=[],providers=[];for(const row of ordered.sort((a,b)=>a.key.localeCompare(b.key))){try{const cost=await inspectServiceProviderCost(ctx,input.kind,row.id,tx),label=await repository.providerLabel(input.kind,row.id);if(!label)throw new ServiceAllocationSourceUnavailableError();providers.push(cost);items.push({id:row.id,label,kind:input.kind,amount:cost.amount.toJSON(),version:(await repository.latestBinding(input.kind,row.id))?.version??0});}catch(error){if(error instanceof ServiceAllocationSourceUnavailableError)continue;throw error;}}
  for(const provider of providers)await provider.recheck();await source.recheckSource();return disclose(ctx,tx,target,serviceAllocationProvidersSchema.parse({items:items.sort((a,b)=>b.id.localeCompare(a.id)),next:scanned.length>50?scanned[49].id:null}));
 },{timeout:120000});
}
