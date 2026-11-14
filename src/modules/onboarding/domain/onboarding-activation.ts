import {z} from "zod";
import {onboardingIdSchema,onboardingCommandFields,onboardingFingerprintSchema} from "./onboarding-contract";
import {onboardingActivationEffectSchema,onboardingActivationEffects,onboardingActivationDependencies} from "./onboarding-activation-policy";

export const onboardingActivationDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("ACTIVATE"),target:z.object({mode:z.literal("BACKGROUND"),propertyId:onboardingIdSchema}).strict()}).strict();
export const onboardingActivationCommandSchema=onboardingActivationDraftSchema.extend(onboardingCommandFields);
export const onboardingActivationReviewSchema=z.object({draft:onboardingActivationDraftSchema,reviewFingerprint:onboardingFingerprintSchema}).strict();
export type OnboardingActivationCommand=z.infer<typeof onboardingActivationCommandSchema>;
export const onboardingActivationRunStateSchema=z.enum(["PENDING","RUNNING","BLOCKED","COMPLETE","FAILED"]);
export const onboardingActivationReceiptSchema=z.object({recorded:z.literal(true),runId:onboardingIdSchema,sessionId:onboardingIdSchema,sourceRevisionId:onboardingIdSchema,propertyId:onboardingIdSchema,idempotencyKey:onboardingIdSchema,requestedAt:z.iso.datetime(),state:onboardingActivationRunStateSchema,completed:z.array(onboardingActivationEffectSchema).max(onboardingActivationEffects.length),activationRevisionId:onboardingIdSchema.nullable(),activatedAt:z.iso.datetime().nullable(),replayed:z.boolean()}).strict().superRefine((value,context)=>{
 if(new Set(value.completed).size!==value.completed.length)context.addIssue({code:"custom",message:"distinct_activation_effects_required",path:["completed"]});
 for(const effect of value.completed)if(onboardingActivationDependencies[effect].some(dependency=>!value.completed.includes(dependency)))context.addIssue({code:"custom",message:"completed_activation_dependencies_required",path:["completed"]});
 if(value.state==="COMPLETE"?(value.completed.length!==onboardingActivationEffects.length||!value.activationRevisionId||!value.activatedAt):Boolean(value.activationRevisionId||value.activatedAt))context.addIssue({code:"custom",message:"only_complete_activation_has_native_operational_receipt"});
});
export const onboardingActivationRecoverySchema=z.object({recorded:z.boolean(),activation:onboardingActivationReceiptSchema.nullable()}).strict().refine(value=>value.recorded===(value.activation!==null));
