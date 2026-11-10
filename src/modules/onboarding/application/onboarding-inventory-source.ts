import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeOnboardingPropertyHeads} from "@/platform/onboarding/property-source";
import {nativeOnboardingInventoryTemplateHeads,nativeOnboardingInventoryTemplateRows,nativeOnboardingInventoryBindingHead,previewNativeOnboardingInventoryTemplate} from "@/platform/onboarding/inventory-source";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {canonicalOnboardingInventorySettings,projectOnboardingInventorySettings,onboardingInventoryRuleKey} from "@/platform/onboarding/contracts";
import {onboardingInventoryTargetSchema,onboardingInventorySnapshotSchema} from "../domain/onboarding-inventory";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";

async function metadata(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown){
 const target=onboardingInventoryTargetSchema.parse(raw);if(target.propertyId!==propertyId)throw new OnboardingAccessError();
 const[property]=await nativeOnboardingPropertyHeads(tx,actor.organizationId,[propertyId]);if(!property)throw new OnboardingAccessError();
 const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await new OnboardingRepository(tx,actor.organizationId).clock(),scope={organizationId:actor.organizationId,propertyId,ownerId,city:property.cityId,region:property.regionId},propertyCheck:CurrentAuthorityCheck={action:"view",resource:{...scope,type:"property",id:propertyId,status:property.status,occurredAt:property.createdAt}};
 assertAccountAuthorization(actor,stored,now,[propertyCheck],new OnboardingAccessError());
 const repository=new ConfigRuleRepository(tx,actor.organizationId),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId,ownerId,asOf:now}),selectedRule=await repository.resolveMetadata({key:onboardingInventoryRuleKey,scopes,asOf:now}),rule=selectedRule?await repository.sourceMetadataWitness(selectedRule.id):null,binding=await nativeOnboardingInventoryBindingHead(tx,actor.organizationId,propertyId),ids=[...new Set([...(target.mode==="TEMPLATE"?[target.templateVersionId]:[]),...binding?[binding.templateVersionId]:[]])],templates=await nativeOnboardingInventoryTemplateHeads(tx,actor.organizationId,ids);
 if(templates.length!==ids.length||templates.some(row=>row.propertyId!==null&&row.propertyId!==propertyId))throw new OnboardingAccessError();
 if(selectedRule&&(!rule||rule.key!==onboardingInventoryRuleKey||rule.lifecycle!=="ACTIVE"||rule.archivedAt!==null||!rule.createdBy||rule.version!==selectedRule.version||rule.scopeType!==selectedRule.scopeType||rule.scopeId!==selectedRule.scopeId))throw new OnboardingConflictError();
 const selectedId=target.mode==="TEMPLATE"?target.templateVersionId:null,selectedTemplate=selectedId?templates.find(row=>row.id===selectedId):null;if(target.mode==="TEMPLATE"&&(!selectedTemplate||selectedTemplate.status!=="ACTIVE"||selectedTemplate.latestStatus!=="ACTIVE"||(binding?.revision??0)!==target.expectedRevision))throw new OnboardingConflictError();
 const checks:CurrentAuthorityCheck[]=[propertyCheck];for(const action of["view","export"]as const){checks.push({action,resource:{...scope,type:"config_rule",id:onboardingInventoryRuleKey,status:"ACTIVE",occurredAt:now}});if(rule)checks.push({action,resource:{...scope,type:"config_rule",id:rule.id,status:rule.lifecycle,occurredAt:rule.createdAt}});for(const row of templates)checks.push({action,resource:{...scope,type:"config_rule",id:row.id,status:row.status,occurredAt:row.createdAt}});}
 assertAccountAuthorization(actor,stored,now,checks,new OnboardingAccessError());
 return{target,property,repository,rule,scopes,binding,templates,selectedTemplate,fingerprint:commandFingerprint({property,rule,scopes,binding,templates})};
}

/** Parent Owner/session, policy, audit and final native admission fences remain with the caller. */
export async function readOnboardingInventorySources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown){
 const before=await metadata(actor,tx,propertyId,ownerId,raw),rows=await nativeOnboardingInventoryTemplateRows(tx,actor.organizationId,before.templates.map(row=>row.id)),rule=before.rule?await before.repository.sourceWitness(before.rule.id):null;
 const after=await metadata(actor,tx,propertyId,ownerId,raw);if(before.fingerprint!==after.fingerprint||rows.length!==before.templates.length||before.rule&&(!rule||rule.xmin!==before.rule.xmin||rule.tuple!==before.rule.tuple))throw new OnboardingConflictError();
 const bindingId=before.binding?.templateVersionId,selectedId=before.target.mode==="TEMPLATE"?before.target.templateVersionId:null,bindingTemplate=bindingId?rows.find(row=>row.id===bindingId):null,selected=selectedId?rows.find(row=>row.id===selectedId):null;
 if(before.binding&&!bindingTemplate||before.target.mode==="TEMPLATE"&&!selected)throw new OnboardingConflictError();
 const templateProjection=(row:NonNullable<typeof selected>)=>({id:row.id,key:row.key,version:row.version,propertyId:row.propertyId,name:row.name,status:row.status,createdBy:row.createdBy,createdAt:row.createdAt.toISOString()}),previous=onboardingInventorySnapshotSchema.parse({propertyId,rule:before.rule?{id:before.rule.id,key:before.rule.key,version:before.rule.version,scopeType:before.rule.scopeType,scopeId:before.rule.scopeId,lifecycle:before.rule.lifecycle,createdBy:before.rule.createdBy,createdAt:before.rule.createdAt.toISOString()}:null,settings:rule?projectOnboardingInventorySettings(rule.value):null,template:bindingTemplate?templateProjection(bindingTemplate):null,templateRevision:before.binding?.revision??null});
 let proposed:ReturnType<typeof projectOnboardingInventorySettings>;try{const value=before.target.mode==="CUSTOM"?canonicalOnboardingInventorySettings(before.target.settings):previewNativeOnboardingInventoryTemplate(rule?.value??null,selected!.values,bindingTemplate?.values??null);if(value===null)throw Error("native_inventory_missing_configuration");proposed=projectOnboardingInventorySettings(value);}catch{throw new OnboardingConfigurationError();}
 return{previous,proposed,selectedTemplate:selected?templateProjection(selected):null,source:{property:before.property,scopes:before.scopes,rule:before.rule,binding:before.binding,templates:before.templates},originalRuleValue:rule?.value??null,originalTemplateValues:rows.map(row=>({id:row.id,values:row.values})),fingerprint:before.fingerprint};
}
