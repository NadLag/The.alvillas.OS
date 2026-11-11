import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {financialRuleSourceChecks,protectedFinancialRuleKey} from "@/platform/config/financial-rule-authority";
import {nativeOnboardingPropertyHeads} from "@/platform/onboarding/property-source";
import {onboardingMaximumConfigurationRecordBytes} from "@/platform/onboarding/limits";
import {onboardingServicesFinancialSourceChecks} from "./onboarding-services-source";
import {onboardingWorkflowsSourceContext} from "./onboarding-workflows-source";
import {onboardingReferenceFact,registeredOnboardingReferenceKey} from "../domain/onboarding-configuration-references";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";

type Rule=Awaited<ReturnType<ConfigRuleRepository["sourceMetadataWitness"]>>;
type Scope={organizationId:string;propertyId:string;ownerId:string;city:string|null;region:string|null};
function referenceChecks(scope:Scope,now:Date,rows:readonly{key:string;rule:Rule|null}[]):CurrentAuthorityCheck[]{
 const checks:CurrentAuthorityCheck[]=[];for(const{key,rule}of rows){if(!registeredOnboardingReferenceKey(key))continue;const financial=protectedFinancialRuleKey(key)||key==="services.pricing",dataClass=financial?"financial"as const:"operational"as const;checks.push(...financialRuleSourceChecks(scope.organizationId,key,"export"));if(key==="services.pricing")checks.push(...onboardingServicesFinancialSourceChecks(scope));for(const action of["view","export"]as const){checks.push({action,resource:{...scope,type:"config_rule",id:key,ruleKey:key,status:"ACTIVE",occurredAt:now,dataClass}});if(rule)checks.push({action,resource:{...scope,type:"config_rule",id:rule.id,ruleKey:key,status:rule.lifecycle,occurredAt:rule.createdAt,dataClass}});}}return checks;
}
async function metadata(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,keys:readonly string[]){
 const context=await onboardingWorkflowsSourceContext(actor,tx,propertyId,ownerId),repository=new ConfigRuleRepository(tx,actor.organizationId),scopes=await new ReservationConfigScopeRepository(tx,actor.organizationId).scopes({propertyId,ownerId,asOf:context.now}),rows:Array<{key:string;rule:Rule|null}>=[];
 for(const key of keys){if(!registeredOnboardingReferenceKey(key)){rows.push({key,rule:null});continue;}const selected=await repository.resolveMetadata({key,scopes,asOf:context.now}),rule=selected?await repository.sourceMetadataWitness(selected.id):null;if(selected&&(!rule||rule.key!==key||rule.version!==selected.version||rule.scopeType!==selected.scopeType||rule.scopeId!==selected.scopeId||rule.lifecycle!=="ACTIVE"||rule.archivedAt!==null))throw new OnboardingConflictError();rows.push({key,rule});}
 assertAccountAuthorization(actor,context.stored,context.now,referenceChecks(context.scope,context.now,rows),new OnboardingAccessError());return{repository,rows,fingerprint:commandFingerprint({property:context.property,scopes,rows})};
}
/** Discover references only in already authorized public workflow definitions, then authorize every dependency before its values. */
export async function readOnboardingConfigurationReferences(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,keys:readonly string[]){
 const before=await metadata(actor,tx,propertyId,ownerId,keys),facts=[],captures=[];let sourceBytes=0;for(const{key,rule}of before.rows){if(rule?.createdBy){const bytes=await before.repository.sourceValueBytes(rule.id);if(bytes===null)throw new OnboardingConflictError();sourceBytes+=bytes;if(sourceBytes>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();}const value=rule?.createdBy?await before.repository.sourceWitness(rule.id):null;if(value&&(!rule||value.xmin!==rule.xmin||value.tuple!==rule.tuple))throw new OnboardingConflictError();const fact=onboardingReferenceFact(key,rule,value?.value);facts.push(fact);if(rule&&value)captures.push({key,id:rule.id,version:rule.version,value:value.value});}
 const after=await metadata(actor,tx,propertyId,ownerId,keys);if(before.fingerprint!==after.fingerprint)throw new OnboardingConflictError();return{facts,captures,source:before.rows,fingerprint:before.fingerprint};
}
/** A completed snapshot retains original dependency identities even after a new effective version is selected. */
export async function authorizeRecordedOnboardingConfigurationReferences(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,pins:readonly{key:string;rule:{id:string;version:number}|null}[]){
 const[property]=await nativeOnboardingPropertyHeads(tx,actor.organizationId,[propertyId],true);if(!property)throw new OnboardingAccessError();const repository=new ConfigRuleRepository(tx,actor.organizationId),rows:Array<{key:string;rule:Rule}>=[];for(const pin of pins){if(!pin.rule||!registeredOnboardingReferenceKey(pin.key))throw new OnboardingAccessError();const rule=await repository.sourceMetadataWitness(pin.rule.id);if(!rule||!rule.createdBy||rule.key!==pin.key||rule.version!==pin.rule.version)throw new OnboardingAccessError();rows.push({key:pin.key,rule});}const stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await new OnboardingRepository(tx,actor.organizationId).clock(),scope={organizationId:actor.organizationId,propertyId,ownerId,city:property.cityId,region:property.regionId};assertAccountAuthorization(actor,stored,now,referenceChecks(scope,now,rows),new OnboardingAccessError());return{fingerprint:commandFingerprint({property,rows})};
}
