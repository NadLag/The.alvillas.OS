import {Prisma,type PropertyOnboardingActivationRequest,type PropertyOnboardingActivationEvent} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {onboardingActivationEffects} from "../domain/onboarding-activation-policy";

export class OnboardingActivationRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lock(id:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":onboarding:activation:"+id},0))`);}
 /** Separate control lock: canonical effect transactions keep their existing independent commit boundaries. */
 async lockExecution(id:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":onboarding:activation-execution:"+id},0))`);}
 eventById(activationId:string,id:string){return this.tx.propertyOnboardingActivationEvent.findFirst({where:{organizationId:this.organizationId,activationId,id}});}
 recoveryPage(afterId?:string){return this.tx.$queryRaw<Array<{activationId:string;outboxEventId:string}>>(Prisma.sql`
  SELECT r.id AS "activationId",source.id AS "outboxEventId" FROM property_onboarding_activation_request r
  JOIN LATERAL(SELECT type FROM property_onboarding_activation_event WHERE organization_id=r.organization_id AND activation_id=r.id ORDER BY sequence DESC LIMIT 1) head ON true
  JOIN outbox_event source ON source.organization_id=r.organization_id AND(source.idempotency_key='onboarding.activation:'||r.id::text OR(source.type='onboarding.activation_continue_requested' AND source.payload->>'activationId'=r.id::text))
  WHERE r.organization_id=${this.organizationId}::uuid AND head.type NOT IN('ACTIVATED','FAILED','BLOCKED') AND source.status='DISPATCHED'
  AND r.id=(SELECT latest.id FROM property_onboarding_activation_request latest WHERE latest.organization_id=r.organization_id AND latest.session_id=r.session_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM outbox_event child WHERE child.organization_id=r.organization_id AND child.idempotency_key='onboarding.activation.continue:'||source.id::text)
  ${afterId?Prisma.sql`AND r.id>${afterId}::uuid`:Prisma.empty} ORDER BY r.id LIMIT 100`);}
 byId(id:string){return this.tx.propertyOnboardingActivationRequest.findFirst({where:{organizationId:this.organizationId,id}});}
 byNonce(commandKey:string){return this.tx.propertyOnboardingActivationRequest.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 currentForSession(sessionId:string){return this.tx.propertyOnboardingActivationRequest.findFirst({where:{organizationId:this.organizationId,sessionId},orderBy:[{createdAt:"desc"},{id:"desc"}]});}
 head(activationId:string){return this.tx.propertyOnboardingActivationEvent.findFirst({where:{organizationId:this.organizationId,activationId},orderBy:{sequence:"desc"}});}
 history(activationId:string,before?:number){return this.tx.propertyOnboardingActivationEvent.findMany({where:{organizationId:this.organizationId,activationId,...before?{sequence:{lt:before}}:{}},orderBy:{sequence:"desc"},take:21});}
 phaseHeads(activationId:string){return this.tx.$queryRaw<PropertyOnboardingActivationEvent[]>(Prisma.sql`SELECT DISTINCT ON(effect_kind) id,organization_id AS "organizationId",activation_id AS "activationId",previous_id AS "previousId",sequence,type,effect_kind AS "effectKind",attempt,result,result_fingerprint AS "resultFingerprint",failure_code AS "failureCode",next_attempt_at AS "nextAttemptAt",actor_id AS "actorId",occurred_at AS "occurredAt",request_id AS "requestId" FROM property_onboarding_activation_event WHERE organization_id=${this.organizationId}::uuid AND activation_id=${activationId}::uuid AND effect_kind IS NOT NULL ORDER BY effect_kind,sequence DESC`);}
 phaseHead(activationId:string,effectKind:typeof onboardingActivationEffects[number]){return this.tx.propertyOnboardingActivationEvent.findFirst({where:{organizationId:this.organizationId,activationId,effectKind},orderBy:{sequence:"desc"}});}
 completionHead(activationId:string){return this.tx.propertyOnboardingActivationEvent.findFirst({where:{organizationId:this.organizationId,activationId,effectKind:null,type:{notIn:["REQUESTED","ACTIVATED"]}},orderBy:{sequence:"desc"}});}
 assertEffect(activationId:string,effectKind:string,result:Prisma.JsonValue,resultFingerprint:string){return this.tx.$queryRaw(Prisma.sql`SELECT true AS verified FROM app_assert_onboarding_activation_effect(${this.organizationId}::uuid,${activationId}::uuid,${effectKind},${JSON.stringify(result)}::jsonb,${resultFingerprint})`);}
 create(input:Omit<Prisma.PropertyOnboardingActivationRequestUncheckedCreateInput,"organizationId">):Promise<PropertyOnboardingActivationRequest>{return this.tx.propertyOnboardingActivationRequest.create({data:{...input,organizationId:this.organizationId}});}
 append(input:Omit<Prisma.PropertyOnboardingActivationEventUncheckedCreateInput,"organizationId">):Promise<PropertyOnboardingActivationEvent>{return this.tx.propertyOnboardingActivationEvent.create({data:{...input,organizationId:this.organizationId}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS onboarding_activation_birth_guard,onboarding_activation_event_guard IMMEDIATE`);}
}
