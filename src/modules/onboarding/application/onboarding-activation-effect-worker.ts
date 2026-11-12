import {randomUUID} from "node:crypto";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {onboardingActivationPolicySchema,type OnboardingActivationPolicy,onboardingActivationDependencies} from "../domain/onboarding-activation-policy";
import {onboardingActivationEffectEvidenceSchema,onboardingActivationEffectProtocol,type OnboardingActivationEffectEvidence} from "../domain/onboarding-activation-effect-evidence";
import {OnboardingAccessError,OnboardingConfigurationError,OnboardingConflictError,OnboardingRateLimitError} from "../domain/onboarding-wizard";
import {OnboardingActivationRepository} from "../infrastructure/onboarding-activation-repository";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {nativeOnboardingActivationReference,nativeOnboardingActivationOriginal} from "./onboarding-service";
import {materializeOnboardingWorkflows} from "./onboarding-activation-workflows";
import {materializeOnboardingActivationTasks} from "./onboarding-activation-tasks";
import {admitActivationOwnerPackage} from "./onboarding-activation-owner-effects";
import {advanceActivationOwnerEmailEvidence} from "./onboarding-activation-email-evidence";

type Effect=OnboardingActivationPolicy["effects"][number];
type Dependencies=Parameters<typeof admitActivationOwnerPackage>[2];
type Reference=Awaited<ReturnType<typeof nativeOnboardingActivationReference>>;
const waitUntil=(now:Date,policy:OnboardingActivationPolicy)=>new Date(now.getTime()+policy.retry.backoff_seconds*1000).toISOString();
async function append(tx:TenantTransaction,run:Reference,details:{type:string;effectKind:Effect;attempt:number;result?:OnboardingActivationEffectEvidence;failureCode?:string;retryAfterSeconds?:number},requestId:string){
 const repository=new OnboardingActivationRepository(tx,run.row.organizationId),head=await repository.head(run.row.id),now=await new OnboardingRepository(tx,run.row.organizationId).clock();if(!head)throw new OnboardingConfigurationError();
 const event=await repository.append({activationId:run.row.id,previousId:head.id,sequence:head.sequence+1,type:details.type,effectKind:details.effectKind,attempt:details.attempt,...details.result?{result:details.result,resultFingerprint:jsonbFingerprint(details.result)}:{},...details.failureCode?{failureCode:details.failureCode}:{},...details.retryAfterSeconds!==undefined?{nextAttemptAt:new Date(now.getTime()+details.retryAfterSeconds*1000)}:{},actorId:run.row.createdBy,occurredAt:now,requestId});
 await writeAuditEvent(tx,{organizationId:run.row.organizationId,actorId:run.row.createdBy,action:"onboarding.activation_event",resourceType:"onboarding",resourceId:run.row.sessionId,propertyScopeId:run.row.propertyId,after:{activationId:run.row.id,eventId:event.id,sequence:event.sequence,type:event.type,effectKind:event.effectKind,attempt:event.attempt,resultFingerprint:event.resultFingerprint,failureCode:event.failureCode},requestId,occurredAt:event.occurredAt});await repository.validateBirth();return event;
}
async function reserve(organizationId:string,activationId:string,deps:Dependencies){return withTenant(deps.db,organizationId,async tx=>{
 const repository=new OnboardingActivationRepository(tx,organizationId);await repository.lock(activationId);const run=await nativeOnboardingActivationReference(organizationId,tx,activationId),policy=onboardingActivationPolicySchema.parse((run.row.policySnapshot as {value:{activation:unknown}}).value.activation),now=await new OnboardingRepository(tx,organizationId).clock();
 if(run.head.type==="ACTIVATED"||run.head.type==="FAILED")return{run,policy,effect:null,attempt:null,state:run.head.type,nextAttemptAt:null};
 const phases=await repository.phaseHeads(activationId),completed=new Set(phases.filter(phase=>phase.type==="SUCCEEDED").map(phase=>phase.effectKind)),effect=policy.effects.find(kind=>!completed.has(kind));
 if(!effect)return{run,policy,effect:null,attempt:null,state:"EFFECTS_COMPLETE",nextAttemptAt:null};
 if(onboardingActivationDependencies[effect].some(kind=>!completed.has(kind)))throw new OnboardingConflictError();const phase=phases.find(phase=>phase.effectKind===effect);
 if(phase?.nextAttemptAt&&phase.nextAttemptAt>now)return{run,policy,effect,attempt:phase.attempt,state:"WAITING",nextAttemptAt:phase.nextAttemptAt.toISOString()};
 if(phase?.type==="STARTED")return{run,policy,effect,attempt:phase.attempt!,state:"STARTED",nextAttemptAt:null};
 const attempt=(phase?.attempt??0)+1;await append(tx,run,{type:"STARTED",effectKind:effect,attempt},deps.requestId??randomUUID());return{run,policy,effect,attempt,state:"STARTED",nextAttemptAt:null};
},{timeout:120000});}
async function perform(organizationId:string,activationId:string,effect:Effect,deps:Dependencies):Promise<OnboardingActivationEffectEvidence|null>{
 await withTenant(deps.db,organizationId,tx=>nativeOnboardingActivationOriginal(organizationId,tx,activationId,deps),{timeout:120000});
 const base={protocol:onboardingActivationEffectProtocol,activationId};
 if(effect==="WORKFLOWS"){const actual=await materializeOnboardingWorkflows(organizationId,activationId,deps);return onboardingActivationEffectEvidenceSchema.parse({...base,effectKind:effect,sourceRuleId:actual.sourceRuleId,sourceFingerprint:actual.sourceFingerprint,workflows:actual.workflows});}
 if(effect==="TASKS"){const actual=await materializeOnboardingActivationTasks(organizationId,activationId,deps);return onboardingActivationEffectEvidenceSchema.parse({...base,effectKind:effect,sourceRuleId:actual.sourceRuleId,sourceFingerprint:actual.sourceFingerprint,tasks:actual.tasks.map(item=>({key:item.key,taskId:item.taskId,commandKey:item.commandKey}))});}
 if(effect==="DOCUMENTS"){const actual=await admitActivationOwnerPackage(organizationId,activationId,deps);if(actual.state==="SOURCE_CHANGED")throw new OnboardingConflictError();if(actual.state!=="COMPLETE")return null;return onboardingActivationEffectEvidenceSchema.parse({...base,effectKind:effect,packageId:actual.packageId});}
 const actual=await advanceActivationOwnerEmailEvidence(organizationId,activationId,deps);if(actual.blockedCode)throw new OnboardingConfigurationError();return effect==="EMAIL"?actual.email:actual.notification;
}

/** Internal reference-only execution. Actual waiting keeps its started attempt; completed artifacts are never substituted by queue acceptance. */
export async function executeNextOnboardingActivationEffect(organizationId:string,activationId:string,deps:Dependencies){
 const claim=await reserve(organizationId,activationId,deps);if(!claim.effect||claim.state!=="STARTED")return{activationId,state:claim.state,effectKind:claim.effect,nextAttemptAt:claim.nextAttemptAt};
 const effect=claim.effect,attempt=claim.attempt!;
 try{
  const evidence=await perform(organizationId,activationId,effect,deps);if(!evidence)return{activationId,state:"WAITING",effectKind:effect,nextAttemptAt:waitUntil(new Date(),claim.policy)};
  return await withTenant(deps.db,organizationId,async tx=>{const repository=new OnboardingActivationRepository(tx,organizationId);await repository.lock(activationId);const run=await nativeOnboardingActivationReference(organizationId,tx,activationId),phase=await repository.phaseHead(activationId,effect);if(phase?.type==="SUCCEEDED")return{activationId,state:"SUCCEEDED",effectKind:effect,nextAttemptAt:null};if(phase?.type!=="STARTED"||phase.attempt!==attempt)throw new OnboardingConflictError();await nativeOnboardingActivationOriginal(organizationId,tx,activationId,deps);await append(tx,run,{type:"SUCCEEDED",effectKind:effect,attempt,result:evidence},deps.requestId??randomUUID());return{activationId,state:"SUCCEEDED",effectKind:effect,nextAttemptAt:null};},{timeout:120000});
 }catch(error){
  if(error instanceof OnboardingRateLimitError)return{activationId,state:"WAITING",effectKind:effect,nextAttemptAt:error.resetAt.toISOString()};
  const blocked=error instanceof OnboardingAccessError||error instanceof OnboardingConflictError||error instanceof OnboardingConfigurationError,failureCode=error instanceof OnboardingAccessError?"AUTHORITY_UNAVAILABLE":error instanceof OnboardingConflictError?"SOURCE_CHANGED":error instanceof OnboardingConfigurationError?"CONFIGURATION_UNAVAILABLE":"EFFECT_EXECUTION_UNAVAILABLE";
  return withTenant(deps.db,organizationId,async tx=>{const repository=new OnboardingActivationRepository(tx,organizationId);await repository.lock(activationId);const run=await nativeOnboardingActivationReference(organizationId,tx,activationId),phase=await repository.phaseHead(activationId,effect);if(phase?.type==="SUCCEEDED")return{activationId,state:"SUCCEEDED",effectKind:effect,nextAttemptAt:null};if(phase?.type!=="STARTED"||phase.attempt!==attempt)return{activationId,state:phase?.type??"BLOCKED",effectKind:effect,nextAttemptAt:phase?.nextAttemptAt?.toISOString()??null};const type=blocked?"BLOCKED":attempt>=claim.policy.retry.max_attempts?"FAILED":"RETRY_SCHEDULED",outcome=await append(tx,run,{type,effectKind:effect,attempt,failureCode,...type==="RETRY_SCHEDULED"?{retryAfterSeconds:claim.policy.retry.backoff_seconds}:{}},deps.requestId??randomUUID());return{activationId,state:type,effectKind:effect,nextAttemptAt:outcome.nextAttemptAt?.toISOString()??null};},{timeout:120000});
 }
}
