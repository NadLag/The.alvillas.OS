import {Prisma,type PropertyOnboardingActivationRequest,type PropertyOnboardingActivationEvent} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {onboardingActivationEffects} from "../domain/onboarding-activation-policy";

export class OnboardingActivationRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lock(id:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":onboarding:activation:"+id},0))`);}
 byId(id:string){return this.tx.propertyOnboardingActivationRequest.findFirst({where:{organizationId:this.organizationId,id}});}
 byNonce(commandKey:string){return this.tx.propertyOnboardingActivationRequest.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 currentForSession(sessionId:string){return this.tx.propertyOnboardingActivationRequest.findFirst({where:{organizationId:this.organizationId,sessionId},orderBy:[{createdAt:"desc"},{id:"desc"}]});}
 head(activationId:string){return this.tx.propertyOnboardingActivationEvent.findFirst({where:{organizationId:this.organizationId,activationId},orderBy:{sequence:"desc"}});}
 history(activationId:string,before?:number){return this.tx.propertyOnboardingActivationEvent.findMany({where:{organizationId:this.organizationId,activationId,...before?{sequence:{lt:before}}:{}},orderBy:{sequence:"desc"},take:21});}
 phaseHeads(activationId:string){return this.tx.$queryRaw<PropertyOnboardingActivationEvent[]>(Prisma.sql`SELECT DISTINCT ON(effect_kind) id,organization_id AS "organizationId",activation_id AS "activationId",previous_id AS "previousId",sequence,type,effect_kind AS "effectKind",attempt,result,result_fingerprint AS "resultFingerprint",failure_code AS "failureCode",next_attempt_at AS "nextAttemptAt",actor_id AS "actorId",occurred_at AS "occurredAt",request_id AS "requestId" FROM property_onboarding_activation_event WHERE organization_id=${this.organizationId}::uuid AND activation_id=${activationId}::uuid AND effect_kind IS NOT NULL ORDER BY effect_kind,sequence DESC`);}
 phaseHead(activationId:string,effectKind:typeof onboardingActivationEffects[number]){return this.tx.propertyOnboardingActivationEvent.findFirst({where:{organizationId:this.organizationId,activationId,effectKind},orderBy:{sequence:"desc"}});}
 create(input:Omit<Prisma.PropertyOnboardingActivationRequestUncheckedCreateInput,"organizationId">):Promise<PropertyOnboardingActivationRequest>{return this.tx.propertyOnboardingActivationRequest.create({data:{...input,organizationId:this.organizationId}});}
 append(input:Omit<Prisma.PropertyOnboardingActivationEventUncheckedCreateInput,"organizationId">):Promise<PropertyOnboardingActivationEvent>{return this.tx.propertyOnboardingActivationEvent.create({data:{...input,organizationId:this.organizationId}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS onboarding_activation_birth_guard,onboarding_activation_event_guard IMMEDIATE`);}
}
