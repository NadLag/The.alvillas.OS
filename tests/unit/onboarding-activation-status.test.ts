import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {onboardingActivationStatusInputSchema,onboardingActivationStatusSchema,onboardingActivationReadinessReferences} from "@/modules/onboarding/domain/onboarding-activation-status";
import {onboardingActivationEffectProtocol as protocol} from "@/modules/onboarding/domain/onboarding-activation-effect-evidence";
import {OnboardingConfigurationError} from "@/modules/onboarding/domain/onboarding-wizard";

const activationId=randomUUID(),packageId=randomUUID(),ownerDeliveryId=randomUUID(),documents={type:"SUCCEEDED",effectKind:"DOCUMENTS",result:{protocol,activationId,effectKind:"DOCUMENTS",packageId}},email={type:"SUCCEEDED",effectKind:"EMAIL",result:{protocol,activationId,effectKind:"EMAIL",ownerDeliveryId,deliveryRecordId:randomUUID(),acceptedAt:new Date().toISOString()}};
describe("native activation status references",()=>{
 it("selects only the actual package and email identities from successful bound phase evidence",()=>{expect(onboardingActivationReadinessReferences(activationId,[email,documents])).toEqual({packageId,ownerDeliveryId});});
 it("does not invent a readiness source for queued or started work",()=>{expect(onboardingActivationReadinessReferences(activationId,[{...documents,type:"STARTED"},{...email,type:"BLOCKED"}])).toEqual({packageId:null,ownerDeliveryId:null});});
 it("allows the actual completed package while canonical email is still pending",()=>{expect(onboardingActivationReadinessReferences(activationId,[documents])).toEqual({packageId,ownerDeliveryId:null});});
 it.each([
  [{...documents,result:{...documents.result,activationId:randomUUID()}}],
  [documents,documents],
  [documents,email,email],
  [email],
  [{...documents,result:email.result}],
  [{...documents,result:{...documents.result,ready:true}}]
 ])("rejects malformed, duplicate, misbound or dependency-free evidence: %j",phases=>{expect(()=>onboardingActivationReadinessReferences(activationId,phases)).toThrow(OnboardingConfigurationError);});
 it("requires an original session and nonce without accepting a client checklist or actor",()=>{const input={sessionId:randomUUID(),idempotencyKey:randomUUID()};expect(onboardingActivationStatusInputSchema.parse(input)).toEqual(input);expect(onboardingActivationStatusInputSchema.safeParse({...input,ready:true,organizationId:randomUUID()}).success).toBe(false);});
 it("requires an absent activation to have no fabricated readiness",()=>{expect(onboardingActivationStatusSchema.parse({recorded:false,activation:null,readiness:null})).toEqual({recorded:false,activation:null,readiness:null});expect(onboardingActivationStatusSchema.safeParse({recorded:false,activation:null,readiness:{ready:true}}).success).toBe(false);});
});
