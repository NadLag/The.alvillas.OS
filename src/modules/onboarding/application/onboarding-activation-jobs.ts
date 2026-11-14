import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {OnboardingActivationRepository} from "../infrastructure/onboarding-activation-repository";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {onboardingActivationRequested} from "../domain/onboarding-activation-payload";
import {onboardingActivationJobReferenceSchema,onboardingActivationRootJobPayloadSchema,onboardingActivationContinuationPayloadSchema,onboardingActivationContinuationRequested,onboardingActivationContinuationKey,onboardingActivationContinuationDue,onboardingActivationJobTerminalHeads} from "../domain/onboarding-activation-job";
import {OnboardingAccessError,OnboardingConflictError} from "../domain/onboarding-wizard";
import {nativeOnboardingActivationReference,completeNativeOnboardingActivation} from "./onboarding-service";
import {executeNextOnboardingActivationEffect} from "./onboarding-activation-effect-worker";

type Reference=ReturnType<typeof onboardingActivationJobReferenceSchema.parse>;
type Dependencies=Parameters<typeof executeNextOnboardingActivationEffect>[2];
async function source(tx:TenantTransaction,input:Reference){
 const outbox=new OutboxRepository(tx,input.organizationId),event=await outbox.event(input.outboxEventId);if(!event||event.status==="FAILED"||![onboardingActivationRequested,onboardingActivationContinuationRequested].includes(event.type))throw new OnboardingAccessError();
 const payload=event.type===onboardingActivationRequested?onboardingActivationRootJobPayloadSchema.parse(event.payload):onboardingActivationContinuationPayloadSchema.parse(event.payload),run=await nativeOnboardingActivationReference(input.organizationId,tx,payload.activationId);
 if(run.event.status==="FAILED")throw new OnboardingAccessError();
 let notBefore:Date|null=event.nextAttemptAt;
 if(event.type===onboardingActivationRequested){if(run.event.id!==event.id)throw new OnboardingAccessError();}
 else{
  const continuation=onboardingActivationContinuationPayloadSchema.parse(event.payload),parent=await outbox.event(continuation.sourceOutboxEventId),head=await new OnboardingActivationRepository(tx,input.organizationId).eventById(run.row.id,continuation.activationHeadId);
  if(!parent||parent.status==="FAILED"||!head||event.idempotencyKey!==onboardingActivationContinuationKey(parent.id)||event.occurredAt<parent.occurredAt||event.occurredAt<head.occurredAt)throw new OnboardingAccessError();
  if(parent.type===onboardingActivationRequested){if(parent.id!==run.event.id)throw new OnboardingAccessError();}else if(parent.type!==onboardingActivationContinuationRequested||onboardingActivationContinuationPayloadSchema.parse(parent.payload).activationId!==run.row.id)throw new OnboardingAccessError();
  if(continuation.notBefore){const bound=new Date(continuation.notBefore);if(!notBefore||bound>notBefore)notBefore=bound;}
 }
 return{run,event,notBefore};
}
async function schedule(tx:TenantTransaction,input:Reference,deps:Dependencies,nextAttemptAt?:string|null){
 const loaded=await source(tx,input),repository=new OnboardingActivationRepository(tx,input.organizationId),native=new OnboardingRepository(tx,input.organizationId),outbox=new OutboxRepository(tx,input.organizationId);
 if(onboardingActivationJobTerminalHeads.has(loaded.run.head.type))return{activationId:loaded.run.row.id,state:loaded.run.head.type,nextAttemptAt:null};
 if((await repository.currentForSession(loaded.run.row.sessionId))?.id!==loaded.run.row.id)return{activationId:loaded.run.row.id,state:"SUPERSEDED",nextAttemptAt:null};
 const existing=await outbox.byIdempotencyKey(onboardingActivationContinuationKey(input.outboxEventId));if(existing)return{activationId:loaded.run.row.id,state:"SCHEDULED",created:false,outboxEventId:existing.id,nextAttemptAt:existing.nextAttemptAt?.toISOString()??null};
 const now=await native.clock();if(loaded.notBefore&&loaded.notBefore>now)return{activationId:loaded.run.row.id,state:"WAITING",nextAttemptAt:loaded.notBefore.toISOString()};
 const policy=(loaded.run.row.policySnapshot as {value:{activation:unknown}}).value.activation,due=onboardingActivationContinuationDue(policy,loaded.run.head,now,nextAttemptAt),payload={activationId:loaded.run.row.id,sourceOutboxEventId:input.outboxEventId,activationHeadId:loaded.run.head.id,notBefore:due?.toISOString()??null},event=await outbox.append(onboardingActivationContinuationRequested,payload,onboardingActivationContinuationKey(input.outboxEventId),now,{nextAttemptAt:due}),requestId=deps.requestId??randomUUID();
 await writeAuditEvent(tx,{organizationId:input.organizationId,actorId:loaded.run.row.createdBy,action:"onboarding.activation_continuation_requested",resourceType:"onboarding",resourceId:loaded.run.row.sessionId,propertyScopeId:loaded.run.row.propertyId,after:{...payload,outboxEventId:event.id},requestId,occurredAt:now});
 await tx.$executeRaw`SET CONSTRAINTS onboarding_activation_job_birth_guard IMMEDIATE`;
 return{activationId:loaded.run.row.id,state:"SCHEDULED",created:true,outboxEventId:event.id,nextAttemptAt:due?.toISOString()??null};
}

/** The signed job carries UUID references only; every effect retains its original authorization and producer gates. */
export async function executeOnboardingActivationJob(raw:unknown,deps:Dependencies){
 const input=onboardingActivationJobReferenceSchema.parse(raw);
 return withTenant(deps.db,input.organizationId,async tx=>{
  const original=await source(tx,input),repository=new OnboardingActivationRepository(tx,input.organizationId);await repository.lockExecution(original.run.row.id);const selected=await source(tx,input),outbox=new OutboxRepository(tx,input.organizationId);
  if(!isDeepStrictEqual(original.event.payload,selected.event.payload)||original.event.idempotencyKey!==selected.event.idempotencyKey)throw new OnboardingConflictError();
  if(onboardingActivationJobTerminalHeads.has(selected.run.head.type))return{activationId:selected.run.row.id,state:selected.run.head.type,nextAttemptAt:null};
  if((await repository.currentForSession(selected.run.row.sessionId))?.id!==selected.run.row.id)return{activationId:selected.run.row.id,state:"SUPERSEDED",nextAttemptAt:null};
  const child=await outbox.byIdempotencyKey(onboardingActivationContinuationKey(input.outboxEventId));if(child)return{activationId:selected.run.row.id,state:"SCHEDULED",created:false,outboxEventId:child.id,nextAttemptAt:child.nextAttemptAt?.toISOString()??null};
  const now=await new OnboardingRepository(tx,input.organizationId).clock();if(selected.notBefore&&selected.notBefore>now)return{activationId:selected.run.row.id,state:"WAITING",nextAttemptAt:selected.notBefore.toISOString()};
  const effect=await executeNextOnboardingActivationEffect(input.organizationId,selected.run.row.id,deps),result=effect.state==="EFFECTS_COMPLETE"?await completeNativeOnboardingActivation(input.organizationId,selected.run.row.id,deps):effect;
  if(["ACTIVATED","COMPLETE","FAILED","BLOCKED","SUPERSEDED"].includes(result.state))return result;
  return schedule(tx,input,deps,result.nextAttemptAt);
 },{timeout:240000});
}

/** Reconcile dispatched leaves after a crash or exhausted infrastructure run; never create another business intent. */
export async function recoverOnboardingActivationJobs(organizationId:string,deps:Dependencies){
 let afterId:string|undefined,recovered=0;
 for(;;){const page=await withTenant(deps.db,organizationId,tx=>new OnboardingActivationRepository(tx,organizationId).recoveryPage(afterId));if(!page.length)return{recovered};
  for(const item of page){const result=await withTenant(deps.db,organizationId,async tx=>{const repository=new OnboardingActivationRepository(tx,organizationId);await repository.lockExecution(item.activationId);return schedule(tx,{organizationId,outboxEventId:item.outboxEventId},deps);},{timeout:240000});if(result.state==="SCHEDULED"&&"created"in result&&result.created)recovered++;}
  afterId=page.at(-1)!.activationId;
 }
}
