import {z} from "zod";
import {onboardingIdSchema as id} from "./onboarding-primitives";
import {onboardingActivationReceiptSchema} from "./onboarding-activation";
import {onboardingReadinessSchema} from "./onboarding-readiness";
import {onboardingActivationEffectEvidenceSchema} from "./onboarding-activation-effect-evidence";
import {OnboardingConfigurationError} from "./onboarding-wizard";

export const onboardingActivationStatusInputSchema=z.object({sessionId:id,idempotencyKey:id}).strict();
export const onboardingActivationStatusSchema=z.discriminatedUnion("recorded",[
 z.object({recorded:z.literal(false),activation:z.null(),readiness:z.null()}).strict(),
 z.object({recorded:z.literal(true),activation:onboardingActivationReceiptSchema,readiness:onboardingReadinessSchema.nullable()}).strict()
]).superRefine((value,context)=>{
 if(value.recorded&&value.readiness&&(value.readiness.sessionId!==value.activation.sessionId||value.readiness.reviewRevisionId!==value.activation.sourceRevisionId||value.readiness.propertyId!==value.activation.propertyId||value.readiness.activation?.runId!==value.activation.runId))context.addIssue({code:"custom",message:"same_native_activation_and_readiness_required"});
});

/** Only protected successful native phase facts can select the canonical readiness readers. */
export function onboardingActivationReadinessReferences(activationId:string,phases:readonly {effectKind:string|null;type:string;result:unknown}[]){
 const selected=id.parse(activationId);let packageId:string|null=null,ownerDeliveryId:string|null=null;
 for(const phase of phases){
  if(phase.type!=="SUCCEEDED"||!(phase.effectKind==="DOCUMENTS"||phase.effectKind==="EMAIL"))continue;
  const parsed=onboardingActivationEffectEvidenceSchema.safeParse(phase.result);
  if(!parsed.success||parsed.data.activationId!==selected||parsed.data.effectKind!==phase.effectKind)throw new OnboardingConfigurationError();
  if(parsed.data.effectKind==="DOCUMENTS"){if(packageId)throw new OnboardingConfigurationError();packageId=parsed.data.packageId;}
  if(parsed.data.effectKind==="EMAIL"){if(ownerDeliveryId)throw new OnboardingConfigurationError();ownerDeliveryId=parsed.data.ownerDeliveryId;}
 }
 if(ownerDeliveryId&&!packageId)throw new OnboardingConfigurationError();
 return{packageId,ownerDeliveryId};
}
