import {nativeOnboardingActivationWorkflowSource,recheckOnboardingActivationWorkflowSource} from "./onboarding-activation-workflow-source";
import {authorizeCollection} from "@/platform/authz/authorize";
import {withTenant} from "@/platform/db/tenant";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";

import {AutomationRepository} from "@/platform/automation/repository";
import {saveOnboardingAutomation} from "@/platform/onboarding/automation-write";

import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {compileOnboardingWorkflows} from "../domain/onboarding-activation-workflows";
import {OnboardingAccessError,OnboardingConflictError} from "../domain/onboarding-wizard";

import {nativeOnboardingActivationAccess,nativeOnboardingActivationOriginal,type OnboardingDependencies} from "./onboarding-service";

/** Materializes the approved operational catalog through canonical automation; it never executes actions or completes a native phase. */
export async function materializeOnboardingWorkflows(organizationId:string,activationId:string,deps:OnboardingDependencies){return withTenant(deps.db,organizationId,async tx=>{
 const access=await nativeOnboardingActivationAccess(organizationId,tx,activationId);if(![access.actor.authContext,access.current.stored].every(context=>authorizeCollection(context,"configure","config_rule")))throw new OnboardingAccessError();
 const first=await nativeOnboardingActivationOriginal(organizationId,tx,activationId,deps);await new AutomationRepository(tx,organizationId).lock("native-onboarding-workflows:"+first.row.propertyId);const loaded=await nativeOnboardingActivationWorkflowSource(organizationId,tx,activationId,deps),{run,native,rules,source,original}=loaded,plan=compileOnboardingWorkflows(organizationId,run.row.propertyId,original.value),outputs=[];let created=0;
 for(const workflow of plan){const key="automation.rule."+workflow.key,resource={type:"config_rule",organizationId,propertyId:run.row.propertyId,ownerId:run.row.ownerId,city:run.property.cityId,region:run.property.regionId,id:key,status:"ACTIVE",occurredAt:await native.clock()};await recheckAccountAuthorization(run.actor,tx,await native.clock(),(["view","export","configure"]as const).map(action=>({action,resource})),new OnboardingAccessError());await rules.lockVersion(key,"property",run.row.propertyId);let metadata=await rules.latestScopeMetadata(key,"property",run.row.propertyId);
  if(metadata){await recheckAccountAuthorization(run.actor,tx,await native.clock(),(["view","export"]as const).map(action=>({action,resource:{...resource,id:metadata!.id,status:metadata!.lifecycle,occurredAt:metadata!.createdAt}})),new OnboardingAccessError());const now=await native.clock(),bytes=await rules.sourceValueBytes(metadata.id);if(metadata.lifecycle!=="ACTIVE"||metadata.archivedAt||!metadata.createdBy||metadata.effectiveFrom>now||metadata.effectiveTo&&metadata.effectiveTo<=now||bytes===null||bytes>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConflictError();const actual=await rules.sourceWitness(metadata.id);if(!actual||jsonbFingerprint(actual.value)!==workflow.fingerprint)throw new OnboardingConflictError();}
  else{await saveOnboardingAutomation({...run.actor,personId:run.actor.authContext.personId},{key:workflow.key,propertyId:run.row.propertyId,lifecycle:source.lifecycle,effectiveFrom:source.effectiveFrom,...source.effectiveTo?{effectiveTo:source.effectiveTo}:{},rule:workflow.rule,reason:"onboarding.activation.workflows:"+run.row.id+":"+source.id},{db:{$transaction:work=>work(tx)},requestId:deps.requestId});metadata=await rules.latestScopeMetadata(key,"property",run.row.propertyId);if(!metadata||metadata.lifecycle!=="ACTIVE"||metadata.createdBy!==run.row.createdBy)throw new OnboardingConflictError();created++;}
  outputs.push({workflowKey:workflow.workflowKey,key,ruleId:metadata.id,version:metadata.version,fingerprint:workflow.fingerprint});
 }
 await recheckOnboardingActivationWorkflowSource(organizationId,tx,activationId,loaded,deps);
 return{activationId:run.row.id,sessionId:run.row.sessionId,reviewRevisionId:run.row.reviewRevisionId,propertyId:run.row.propertyId,sourceRuleId:source.id,sourceFingerprint:jsonbFingerprint(original.value),workflows:outputs,replayed:created===0};
},{timeout:120000});}
