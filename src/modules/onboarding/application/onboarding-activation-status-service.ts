import {withTenant} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {onboardingActivationStatusInputSchema,onboardingActivationStatusSchema,onboardingActivationReadinessReferences} from "../domain/onboarding-activation-status";
import {OnboardingConflictError} from "../domain/onboarding-wizard";
import {OnboardingActivationRepository} from "../infrastructure/onboarding-activation-repository";
import {recoverOnboardingActivation} from "./onboarding-service";
import {readOnboardingReadiness} from "./onboarding-readiness-service";

type Dependencies=Parameters<typeof recoverOnboardingActivation>[2];
/** One tenant transaction composes the existing protected original and actual-readiness readers. */
export async function readOnboardingActivationStatus(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=onboardingActivationStatusInputSchema.parse(raw);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const shared:Dependencies={...deps,db:{$transaction:work=>work(tx)}},recovered=await recoverOnboardingActivation(actor,input,shared);
  if(!recovered.recorded||!recovered.activation)return onboardingActivationStatusSchema.parse({recorded:false,activation:null,readiness:null});
  const activation=recovered.activation,phases=await new OnboardingActivationRepository(tx,actor.organizationId).phaseHeads(activation.runId),references=onboardingActivationReadinessReferences(activation.runId,phases);
  if(!references.packageId)return onboardingActivationStatusSchema.parse({recorded:true,activation,readiness:null});
  const readiness=await readOnboardingReadiness(actor,{sessionId:input.sessionId,reviewRevisionId:activation.sourceRevisionId,packageId:references.packageId,...references.ownerDeliveryId?{ownerDeliveryId:references.ownerDeliveryId}:{}},shared);
  if(readiness.activation?.runId!==activation.runId)throw new OnboardingConflictError();
  return onboardingActivationStatusSchema.parse({recorded:true,activation:readiness.activation,readiness});
 },{timeout:120000});
}
