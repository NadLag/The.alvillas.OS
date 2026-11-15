import type {z} from "zod";
import type {Prisma} from "@prisma/client";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {present} from "@/platform/authz/present";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {serviceCatalogRuleKey,servicePricingSchema} from "@/platform/config/service-catalog-policy";
import {writePropertyConfiguration} from "@/platform/config/property-configuration";
import {nativeServiceCatalogActor} from "@/platform/services/catalog-provider-source";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {canonicalServiceCatalogEntry,serviceCatalogSelection,ServiceCatalogAccessError,ServiceCatalogConflictError,type ServiceCatalogEntry} from "../domain/service-catalog";
import {serviceCatalogDraftSchema,serviceCatalogCommandSchema,serviceCatalogPageSchema,serviceCatalogHistorySchema,serviceCatalogVersionSchema,serviceCatalogRecoverSchema,serviceCatalogReceiptSchema,serviceCatalogPublished,type ServiceCatalogCommand} from "../domain/service-catalog-command";
import {ServiceCatalogRepository} from "../infrastructure/service-catalog-repository";
import {readNativeServiceCatalog,serviceCatalogSourceContext,serviceCatalogTermsSources} from "./service-catalog-source";

type Dependencies={db?:TenantTransactionRunner;requestId:string;ipAddress:string|null};
const asJson=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
type Context=Awaited<ReturnType<typeof readNativeServiceCatalog>>;
const authority=(context:Context)=>context.authorizationFingerprint;
const stableScope=(context:Context)=>jsonbFingerprint({property:context.property,scopes:context.scopes});
function project(actor:AccountActorContext,context:Context,entry:ServiceCatalogEntry,policy:Awaited<ReturnType<typeof serviceCatalogTermsSources>>["policies"][number]|undefined){
 const data={key:entry.key,name:entry.name??null,description:entry.description??null,available:entry.available??null,pricingModel:entry.pricing_model,amount:entry.amount??null,currency:entry.currency??null,orderTerms:entry.order_terms??null,financialPolicy:policy??null};
 return present({...actor.authContext,visibleDataClasses:new Set(["financial","personal"]as const)},"view",{...context.target,data},{},context.now);
}
async function prepare(actor:AccountActorContext,tx:TenantTransaction,draft:z.infer<typeof serviceCatalogDraftSchema>){
 const context=await readNativeServiceCatalog(actor,tx,draft.scope,"configure"),previous=context.catalog?.services.find(item=>item.key===draft.entry.key),entry=canonicalServiceCatalogEntry(draft.entry,previous),terms=await serviceCatalogTermsSources(actor,tx,context,[entry],true),services=context.catalog?.services??[],next=servicePricingSchema.parse({...context.catalog,services:previous?services.map(item=>item.key===entry.key?entry:item):[...services,entry]});
 // A more specific agreement/channel policy must be edited through its existing
 // configuration workflow; silently creating a hidden property rule is unsafe.
 if(context.rule&&["agreement","booking_source_property","role_assignment"].includes(context.rule.scopeType))throw new ServiceCatalogConflictError();
 const reviewFingerprint=jsonbFingerprint({protocol:"native-service-catalog-v1",actorId:actor.actorId,draft,source:context.fingerprint,authority:authority(context),terms:terms.fingerprint,catalog:context.catalog,next});
 return{context,entry,next,terms,reviewFingerprint};
}
export async function previewServiceCatalogChange(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const draft=serviceCatalogDraftSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const before=await prepare(actor,tx,draft),after=await prepare(actor,tx,draft);if(before.reviewFingerprint!==after.reviewFingerprint)throw new ServiceCatalogConflictError();
  return{reviewFingerprint:after.reviewFingerprint,baseRule:after.context.rule?{id:after.context.rule.id,version:after.context.rule.version,scopeType:after.context.rule.scopeType}:null,entry:project(actor,after.context,after.entry,after.terms.policies[0])};
 });
}
async function originalReceipt(actor:AccountActorContext,tx:TenantTransaction,input:z.infer<typeof serviceCatalogRecoverSchema>){
 const context=await serviceCatalogSourceContext(actor,tx,input.scope,"configure"),event=await new OutboxRepository(tx,actor.organizationId).byIdempotencyKey(`service-catalog:${input.idempotencyKey}`);if(!event)return null;
 const value=serviceCatalogReceiptSchema.parse(event.payload);if(event.type!==serviceCatalogPublished||value.actorId!==actor.actorId||value.propertyId!==input.scope.propertyId||value.ownerId!==(input.scope.ownerId??null))throw new ServiceCatalogConflictError();
 const head=await context.repository.sourceMetadataWitness(value.ruleId);if(!head||head.key!==serviceCatalogRuleKey||head.scopeType!=="property"||head.scopeId!==value.propertyId||head.createdBy!==actor.actorId||head.version!==value.ruleVersion||head.archivedAt)throw new ServiceCatalogAccessError();
 const checks:CurrentAuthorityCheck[]=(["view","export"]as const).map(action=>({action,unconditional:true,resource:{...context.scope,type:"config_rule",id:head.id,dataClass:"financial",status:head.lifecycle,occurredAt:head.createdAt}}));assertAccountAuthorization(actor,context.stored,context.now,checks,new ServiceCatalogAccessError());
 const original=await context.repository.sourceWitness(head.id);if(!original||original.xmin!==head.xmin||original.tuple!==head.tuple)throw new ServiceCatalogConflictError();const entry=servicePricingSchema.parse(original.value).services.find(row=>row.key===value.serviceKey);if(!entry)throw new ServiceCatalogConflictError();const terms=await serviceCatalogTermsSources(actor,tx,context,[entry]);
 return{value,entry,fingerprint:jsonbFingerprint({value,source:original,context:context.fingerprint,authority:context.authorizationFingerprint,terms:terms.fingerprint})};
}
async function receipt(actor:AccountActorContext,tx:TenantTransaction,command:ServiceCatalogCommand){
 const original=await originalReceipt(actor,tx,{scope:command.draft.scope,idempotencyKey:command.idempotencyKey});if(!original)return null;const{value,entry}=original;
 if(value.commandHash!==jsonbFingerprint(command)||value.serviceKey!==command.draft.entry.key||jsonbFingerprint(canonicalServiceCatalogEntry(command.draft.entry,entry))!==jsonbFingerprint(entry))throw new ServiceCatalogConflictError();
 return{ruleId:value.ruleId,ruleVersion:value.ruleVersion,serviceKey:value.serviceKey,replayed:true};
}
export async function recoverServiceCatalogChange(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=serviceCatalogRecoverSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  await new ServiceCatalogRepository(tx,actor.organizationId).lockCommand(input.idempotencyKey);const before=await originalReceipt(actor,tx,input),after=await originalReceipt(actor,tx,input);if(before?.fingerprint!==after?.fingerprint)throw new ServiceCatalogConflictError();
  return{propertyId:input.scope.propertyId,idempotencyKey:input.idempotencyKey,recorded:Boolean(after),receipt:after?{ruleId:after.value.ruleId,ruleVersion:after.value.ruleVersion,serviceKey:after.value.serviceKey}:null};
 });
}
export async function publishServiceCatalogChange(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const command=serviceCatalogCommandSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const native=new ServiceCatalogRepository(tx,actor.organizationId);await native.lockCommand(command.idempotencyKey);
  const previous=await receipt(actor,tx,command);if(previous){const final=await receipt(actor,tx,command);if(!final||jsonbFingerprint(previous)!==jsonbFingerprint(final))throw new ServiceCatalogConflictError();return final;}
  const initial=await serviceCatalogSourceContext(actor,tx,command.draft.scope,"configure");await initial.repository.lockVersion(serviceCatalogRuleKey,"property",command.draft.scope.propertyId);
  const prepared=await prepare(actor,tx,command.draft);if(prepared.reviewFingerprint!==command.reviewFingerprint)throw new ServiceCatalogConflictError();
  const account=await nativeServiceCatalogActor(actor,tx),created=await writePropertyConfiguration(account,{...command.draft.scope,key:serviceCatalogRuleKey,value:prepared.next,reason:command.draft.reason},{tx,requestId:deps.requestId,ipAddress:deps.ipAddress});
  const final=await readNativeServiceCatalog(actor,tx,command.draft.scope,"configure"),terms=await serviceCatalogTermsSources(actor,tx,final,[prepared.entry],true),accountAfter=await nativeServiceCatalogActor(actor,tx);
  if(final.rule?.id!==created.id||jsonbFingerprint(final.catalog)!==jsonbFingerprint(prepared.next)||stableScope(prepared.context)!==stableScope(final)||authority(prepared.context)!==authority(final)||terms.fingerprint!==prepared.terms.fingerprint||accountAfter.personId!==account.personId)throw new ServiceCatalogConflictError();
  const payload=serviceCatalogReceiptSchema.parse({schemaVersion:1,actorId:actor.actorId,propertyId:command.draft.scope.propertyId,ownerId:command.draft.scope.ownerId??null,serviceKey:prepared.entry.key,ruleId:created.id,ruleVersion:created.version,commandHash:jsonbFingerprint(command),reviewFingerprint:command.reviewFingerprint});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"service.catalog.published",resourceType:"config_rule",resourceId:created.id,propertyScopeId:command.draft.scope.propertyId,after:{key:serviceCatalogRuleKey,...payload},reason:command.draft.reason,requestId:deps.requestId,ipAddress:deps.ipAddress,occurredAt:final.now});
  await new OutboxRepository(tx,actor.organizationId).append(serviceCatalogPublished,asJson(payload),`service-catalog:${command.idempotencyKey}`,final.now);
  const committed=await readNativeServiceCatalog(actor,tx,command.draft.scope,"configure"),committedTerms=await serviceCatalogTermsSources(actor,tx,committed,[prepared.entry],true);
  if(committed.fingerprint!==final.fingerprint||authority(committed)!==authority(final)||committedTerms.fingerprint!==terms.fingerprint)throw new ServiceCatalogConflictError();
  return{ruleId:created.id,ruleVersion:created.version,serviceKey:prepared.entry.key,replayed:false};
 });
}
export async function serviceCatalogPage(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=serviceCatalogPageSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const context=await readNativeServiceCatalog(actor,tx,input.scope),{selected,next}=serviceCatalogSelection(context.catalog?.services??[],input),terms=await serviceCatalogTermsSources(actor,tx,context,selected),after=await readNativeServiceCatalog(actor,tx,input.scope),termsAfter=await serviceCatalogTermsSources(actor,tx,after,selected);
  if(context.fingerprint!==after.fingerprint||authority(context)!==authority(after)||terms.fingerprint!==termsAfter.fingerprint)throw new ServiceCatalogConflictError();
  return{rule:context.rule?{id:context.rule.id,version:context.rule.version,scopeType:context.rule.scopeType}:null,items:selected.map(row=>project(actor,after,row,termsAfter.policies.find(policy=>policy.serviceKey===row.key))),next};
 });
}
function historyAuthority(actor:AccountActorContext,context:Awaited<ReturnType<typeof serviceCatalogSourceContext>>,rows:readonly{id:string;lifecycle:string;createdAt:Date}[]){
 const checks:CurrentAuthorityCheck[]=rows.flatMap(row=>(["view","export"]as const).map(action=>({action,unconditional:true,resource:{...context.scope,type:"config_rule",id:row.id,dataClass:"financial"as const,status:row.lifecycle,occurredAt:row.createdAt}})));assertAccountAuthorization(actor,context.stored,context.now,checks,new ServiceCatalogAccessError());
}
export async function serviceCatalogHistory(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=serviceCatalogHistorySchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const context=await serviceCatalogSourceContext(actor,tx,input.scope),rows=await new ServiceCatalogRepository(tx,actor.organizationId).history(input.scope.propertyId,input.afterVersion),selected=rows.slice(0,20);historyAuthority(actor,context,selected);
  const after=await serviceCatalogSourceContext(actor,tx,input.scope);historyAuthority(actor,after,selected);if(context.fingerprint!==after.fingerprint||context.authorizationFingerprint!==after.authorizationFingerprint)throw new ServiceCatalogConflictError();return{items:selected,nextVersion:rows.length>20?selected.at(-1)!.version:null};
 });
}
export async function serviceCatalogVersion(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=serviceCatalogVersionSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const context=await serviceCatalogSourceContext(actor,tx,input.scope),head=await context.repository.sourceMetadataWitness(input.ruleId);if(!head||head.key!==serviceCatalogRuleKey||head.archivedAt||head.scopeType!=="property"||head.scopeId!==input.scope.propertyId)throw new ServiceCatalogAccessError();historyAuthority(actor,context,[head]);
  const row=await context.repository.sourceWitness(head.id);if(!row||row.xmin!==head.xmin||row.tuple!==head.tuple)throw new ServiceCatalogConflictError();const catalog=servicePricingSchema.parse(row.value),{selected,next}=serviceCatalogSelection(catalog.services,input),terms=await serviceCatalogTermsSources(actor,tx,context,selected),after=await serviceCatalogSourceContext(actor,tx,input.scope),final=await after.repository.sourceMetadataWitness(head.id),termsAfter=await serviceCatalogTermsSources(actor,tx,after,selected);historyAuthority(actor,after,[head]);
  if(!final||head.xmin!==final.xmin||head.tuple!==final.tuple||context.fingerprint!==after.fingerprint||context.authorizationFingerprint!==after.authorizationFingerprint||terms.fingerprint!==termsAfter.fingerprint)throw new ServiceCatalogConflictError();
  return{rule:{id:head.id,version:head.version,scopeType:head.scopeType,lifecycle:head.lifecycle,createdAt:head.createdAt.toISOString()},items:selected.map(entry=>project(actor,{...after,catalog},entry,termsAfter.policies.find(policy=>policy.serviceKey===entry.key))),next};
 });
}
