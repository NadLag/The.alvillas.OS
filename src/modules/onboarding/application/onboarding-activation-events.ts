import type {TenantTransaction} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {OnboardingActivationRepository} from "../infrastructure/onboarding-activation-repository";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {OnboardingConfigurationError} from "../domain/onboarding-wizard";
import type {OnboardingActivationPolicy} from "../domain/onboarding-activation-policy";
import type {OnboardingActivationEffectEvidence} from "../domain/onboarding-activation-effect-evidence";
import type {nativeOnboardingActivationReference} from "./onboarding-service";

type Reference=Awaited<ReturnType<typeof nativeOnboardingActivationReference>>;
export async function appendNativeOnboardingActivationEvent(tx:TenantTransaction,run:Reference,details:{type:string;effectKind:OnboardingActivationPolicy["effects"][number]|null;attempt:number|null;result?:OnboardingActivationEffectEvidence|{revisionId:string;activatedAt:string};failureCode?:string;retryAfterSeconds?:number;occurredAt?:Date},requestId:string){
 const repository=new OnboardingActivationRepository(tx,run.row.organizationId),head=await repository.head(run.row.id),now=details.occurredAt??await new OnboardingRepository(tx,run.row.organizationId).clock();if(!head)throw new OnboardingConfigurationError();
 const event=await repository.append({activationId:run.row.id,previousId:head.id,sequence:head.sequence+1,type:details.type,effectKind:details.effectKind,attempt:details.attempt,...details.result?{result:details.result,resultFingerprint:jsonbFingerprint(details.result)}:{},...details.failureCode?{failureCode:details.failureCode}:{},...details.retryAfterSeconds!==undefined?{nextAttemptAt:new Date(now.getTime()+details.retryAfterSeconds*1000)}:{},actorId:run.row.createdBy,occurredAt:now,requestId});
 await writeAuditEvent(tx,{organizationId:run.row.organizationId,actorId:run.row.createdBy,action:"onboarding.activation_event",resourceType:"onboarding",resourceId:run.row.sessionId,propertyScopeId:run.row.propertyId,after:{activationId:run.row.id,eventId:event.id,sequence:event.sequence,type:event.type,effectKind:event.effectKind,attempt:event.attempt,resultFingerprint:event.resultFingerprint,failureCode:event.failureCode},requestId,occurredAt:event.occurredAt});await repository.validateBirth();return event;
}
