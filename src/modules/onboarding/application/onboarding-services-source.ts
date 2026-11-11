import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeOnboardingPropertyHeads} from "@/platform/onboarding/property-source";
import {nativeOnboardingServicesTemplateHeads,nativeOnboardingServicesTemplateRows,nativeOnboardingServicesBindingHead,previewNativeOnboardingServicesTemplate} from "@/platform/onboarding/services-source";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {canonicalOnboardingServicesSettings,projectOnboardingServicesSettings,onboardingServicesRuleKey} from "@/platform/onboarding/contracts";
import {onboardingServicesTargetSchema,onboardingServicesSnapshotSchema,onboardingServicesSourcePinsSchema} from "../domain/onboarding-services";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";

export async function onboardingServicesSourceMetadata(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown){
 const target=raw===null?null:onboardingServicesTargetSchema.parse(raw);if(target&&target.propertyId!==propertyId)throw new OnboardingAccessError();
 const{property,stored,now,scope}=await onboardingServicesSourceContext(actor,tx,propertyId,ownerId),propertyCheck:CurrentAuthorityCheck={action:"view",resource:{...scope,type:"property",id:propertyId,status:property.status,occurredAt:property.createdAt}};
 const repository=new ConfigRuleRepository(tx,actor.organizationId),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId,ownerId,asOf:now}),selectedRule=await repository.resolveMetadata({key:onboardingServicesRuleKey,scopes,asOf:now}),rule=selectedRule?await repository.sourceMetadataWitness(selectedRule.id):null,binding=await nativeOnboardingServicesBindingHead(tx,actor.organizationId,propertyId),ids=[...new Set([...(target?.mode==="TEMPLATE"?[target.templateVersionId]:[]),...binding?[binding.templateVersionId]:[]])],templates=await nativeOnboardingServicesTemplateHeads(tx,actor.organizationId,ids);
 if(templates.length!==ids.length||templates.some(row=>row.propertyId!==null&&row.propertyId!==propertyId))throw new OnboardingAccessError();
 if(selectedRule&&(!rule||rule.key!==onboardingServicesRuleKey||target!==null&&rule.lifecycle!=="ACTIVE"||rule.archivedAt!==null||target!==null&&!rule.createdBy||rule.version!==selectedRule.version||rule.scopeType!==selectedRule.scopeType||rule.scopeId!==selectedRule.scopeId))throw new OnboardingConflictError();
 if(target?.mode==="LINK"&&(!rule||rule.id!==target.ruleId))throw new OnboardingConflictError();
 const selectedId=target?.mode==="TEMPLATE"?target.templateVersionId:null,selectedTemplate=selectedId?templates.find(row=>row.id===selectedId):null;if(target?.mode==="TEMPLATE"&&(!selectedTemplate||selectedTemplate.status!=="ACTIVE"||selectedTemplate.latestStatus!=="ACTIVE"||(binding?.revision??0)!==target.expectedRevision))throw new OnboardingConflictError();
 const checks:CurrentAuthorityCheck[]=[propertyCheck,...onboardingServicesFinancialSourceChecks(scope)];for(const action of["view","export"]as const){checks.push({action,resource:{...scope,dataClass:"financial",type:"config_rule",id:onboardingServicesRuleKey,status:"ACTIVE",occurredAt:now}});if(rule)checks.push({action,resource:{...scope,dataClass:"financial",type:"config_rule",id:rule.id,status:rule.lifecycle,occurredAt:rule.createdAt}});for(const row of templates)checks.push({action,resource:{...scope,dataClass:"financial",type:"config_rule",id:row.id,status:row.status,occurredAt:row.createdAt}});}
 assertAccountAuthorization(actor,stored,now,checks,new OnboardingAccessError());
 return{target,property,repository,rule,scopes,binding,templates,selectedTemplate,fingerprint:commandFingerprint({property,rule,scopes,binding,templates})};
}

/** Metadata only: the actual geography and ownership define all scoped source checks. */
export async function onboardingServicesSourceContext(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,includeArchived=false){
 const[property]=await nativeOnboardingPropertyHeads(tx,actor.organizationId,[propertyId],includeArchived);if(!property)throw new OnboardingAccessError();
 const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await new OnboardingRepository(tx,actor.organizationId).clock(),scope={organizationId:actor.organizationId,propertyId,ownerId:property.ownership.some(row=>row.ownerId===ownerId)?ownerId:undefined,city:property.cityId,region:property.regionId};
 assertAccountAuthorization(actor,stored,now,[{action:"view",resource:{...scope,type:"property",id:propertyId,status:property.status,occurredAt:property.createdAt}}],new OnboardingAccessError());return{property,stored,now,scope};
}

/** One bounded metadata query filters identities before names or item counts are requested. */
export async function onboardingServicesTemplateChoiceWitness(actor:AccountActorContext,tx:TenantTransaction,context:Awaited<ReturnType<typeof onboardingServicesSourceContext>>,ids:readonly string[]){
 const templates=await nativeOnboardingServicesTemplateHeads(tx,actor.organizationId,ids),byId=new Map(templates.map(row=>[row.id,row])),permitted:string[]=[];
 for(const id of ids){const row=byId.get(id);if(!row||row.status!=="ACTIVE"||row.latestStatus!=="ACTIVE"||row.propertyId!==null&&row.propertyId!==context.property.id)continue;try{
  assertAccountAuthorization(actor,context.stored,context.now,[...onboardingServicesFinancialSourceChecks(context.scope),...(["view","export"]as const).map(action=>({action,resource:{...context.scope,dataClass:"financial"as const,type:"config_rule",id:row.id,status:row.status,occurredAt:row.createdAt}}))],new OnboardingAccessError());permitted.push(id);
 }catch(error){if(!(error instanceof OnboardingAccessError))throw error;}}
 return{permitted,fingerprint:commandFingerprint({property:context.property,templates})};
}

/** Parent Owner/session, policy, audit and final native admission fences remain with the caller. */
export async function readOnboardingServicesSources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown){
 const before=await onboardingServicesSourceMetadata(actor,tx,propertyId,ownerId,raw);if(!before.target)throw new OnboardingConfigurationError();const{rows,rule,bindingTemplate,selected,templateProjection,previous}=await sourceValues(actor,tx,propertyId,ownerId,raw,before);
 let proposed:ReturnType<typeof projectOnboardingServicesSettings>;try{const value=before.target?.mode==="LINK"?rule!.value:before.target?.mode==="CUSTOM"?canonicalOnboardingServicesSettings(before.target.settings):previewNativeOnboardingServicesTemplate(rule?.value??null,selected!.values,bindingTemplate?.values??null);if(value===null)throw Error("native_services_missing_configuration");proposed=projectOnboardingServicesSettings(value);}catch{throw new OnboardingConfigurationError();}
 return{previous,proposed,selectedTemplate:selected?templateProjection(selected):null,source:{property:before.property,scopes:before.scopes,rule:before.rule,binding:before.binding,templates:before.templates},originalRuleValue:rule?.value??null,originalTemplateValues:rows.map(row=>({id:row.id,values:row.values})),fingerprint:before.fingerprint};
}


async function sourceValues(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown,before:Awaited<ReturnType<typeof onboardingServicesSourceMetadata>>){
 const rows=await nativeOnboardingServicesTemplateRows(tx,actor.organizationId,before.templates.map(row=>row.id)),rule=before.rule?await before.repository.sourceWitness(before.rule.id):null;
 const after=await onboardingServicesSourceMetadata(actor,tx,propertyId,ownerId,raw);if(before.fingerprint!==after.fingerprint||rows.length!==before.templates.length||before.rule&&(!rule||rule.xmin!==before.rule.xmin||rule.tuple!==before.rule.tuple))throw new OnboardingConflictError();
 const bindingId=before.binding?.templateVersionId,selectedId=before.target?.mode==="TEMPLATE"?before.target.templateVersionId:null,bindingTemplate=bindingId?rows.find(row=>row.id===bindingId):null,selected=selectedId?rows.find(row=>row.id===selectedId):null;
 if(before.binding&&!bindingTemplate||before.target?.mode==="TEMPLATE"&&!selected)throw new OnboardingConflictError();
 const templateProjection=(row:NonNullable<typeof selected>)=>({id:row.id,key:row.key,version:row.version,propertyId:row.propertyId,name:row.name,status:row.status,createdBy:row.createdBy,createdAt:row.createdAt.toISOString()}),previous=onboardingServicesSnapshotSchema.parse({propertyId,rule:before.rule?{id:before.rule.id,key:before.rule.key,version:before.rule.version,scopeType:before.rule.scopeType,scopeId:before.rule.scopeId,lifecycle:before.rule.lifecycle,createdBy:before.rule.createdBy,createdAt:before.rule.createdAt.toISOString()}:null,settings:rule?projectOnboardingServicesSettings(rule.value):null,template:bindingTemplate?templateProjection(bindingTemplate):null,templateRevision:before.binding?.revision??null});
 return{rows,rule,bindingTemplate,selected,templateProjection,previous};
}

/** Read the current configuration without proposing or applying a new command. */
export async function readCurrentOnboardingServicesSources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string){
 const before=await onboardingServicesSourceMetadata(actor,tx,propertyId,ownerId,null),values=await sourceValues(actor,tx,propertyId,ownerId,null,before);return{snapshot:values.previous,source:{property:before.property,scopes:before.scopes,rule:before.rule,binding:before.binding,templates:before.templates},originalRuleValue:values.rule?.value??null,originalTemplateValues:values.rows.map(row=>({id:row.id,values:row.values})),fingerprint:before.fingerprint};
}

/** Source pins contain original identities and version witnesses, never private configuration values. */
export function onboardingServicesSourcePins(before:Awaited<ReturnType<typeof readOnboardingServicesSources>>,after:Awaited<ReturnType<typeof readOnboardingServicesSources>>){
 const pin=(row:{id:string;rowVersion:string;tuple:string})=>({id:row.id,rowVersion:row.rowVersion,tuple:row.tuple});
 const sources=(value:typeof before)=>({rule:value.source.rule?{id:value.source.rule.id,rowVersion:value.source.rule.xmin,tuple:value.source.rule.tuple}:null,binding:value.source.binding?{...pin(value.source.binding),revision:value.source.binding.revision,templateVersionId:value.source.binding.templateVersionId}:null});
 const templates=new Map<string,{id:string;rowVersion:string;tuple:string}>();for(const row of [...before.source.templates,...after.source.templates]){const previous=templates.get(row.id),value=pin(row);if(previous&&commandFingerprint(previous)!==commandFingerprint(value))throw new OnboardingConflictError();templates.set(row.id,value);}
 return onboardingServicesSourcePinsSchema.parse({before:sources(before),after:sources(after),templates:[...templates.values()].sort((a,b)=>a.id.localeCompare(b.id))});
}

/** History authorizes all original source identities before decrypting their retained values. */
export async function authorizeRecordedOnboardingServicesSources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown){
 const pins=onboardingServicesSourcePinsSchema.parse(raw),[property]=await nativeOnboardingPropertyHeads(tx,actor.organizationId,[propertyId],true);if(!property)throw new OnboardingAccessError();
 const repository=new ConfigRuleRepository(tx,actor.organizationId),ruleIds=[...new Set([pins.before.rule?.id,pins.after.rule?.id].filter((id):id is string=>id!==undefined))],rules=await Promise.all(ruleIds.map(id=>repository.sourceMetadataWitness(id))),templates=await nativeOnboardingServicesTemplateHeads(tx,actor.organizationId,pins.templates.map(row=>row.id));
 if(rules.some(row=>!row||row.key!==onboardingServicesRuleKey)||templates.length!==pins.templates.length||templates.some(row=>row.propertyId!==null&&row.propertyId!==propertyId))throw new OnboardingAccessError();
 const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await new OnboardingRepository(tx,actor.organizationId).clock(),scope={organizationId:actor.organizationId,propertyId,ownerId,city:property.cityId,region:property.regionId},checks:CurrentAuthorityCheck[]=[{action:"view",resource:{...scope,type:"property",id:propertyId,status:property.status,occurredAt:property.createdAt}},...onboardingServicesFinancialSourceChecks(scope)];
 for(const action of["view","export"]as const){checks.push({action,resource:{...scope,dataClass:"financial",type:"config_rule",id:onboardingServicesRuleKey,status:"ACTIVE",occurredAt:now}});for(const row of rules){if(!row)throw new OnboardingAccessError();checks.push({action,resource:{...scope,dataClass:"financial",type:"config_rule",id:row.id,status:row.lifecycle,occurredAt:row.createdAt}});}for(const row of templates)checks.push({action,resource:{...scope,dataClass:"financial",type:"config_rule",id:row.id,status:row.status,occurredAt:row.createdAt}});}
 assertAccountAuthorization(actor,stored,now,checks,new OnboardingAccessError());return{fingerprint:commandFingerprint({property,rules,templates})};
}

/** Catalog prices use the canonical financial source, independently of operational property grants. */
export function onboardingServicesFinancialSourceChecks(scope:{organizationId:string;propertyId:string;ownerId?:string;city?:string|null;region?:string|null}):CurrentAuthorityCheck[]{return(["view","export"]as const).map(action=>({action,unconditional:true,resource:{...scope,type:"financial_transaction",dataClass:"financial"}}));}
