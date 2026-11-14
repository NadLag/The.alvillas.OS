import {z} from "zod";
import {onboardingIdSchema as id} from "./onboarding-primitives";

export const onboardingActivationWorkspaceInputSchema=z.object({sessionId:id}).strict();
export const onboardingActivationWorkspaceSchema=z.object({
 sessionId:id,property:z.object({id,name:z.string().min(1)}).strict().nullable(),
 review:z.object({revisionId:id,propertyId:id}).strict().nullable(),canApprove:z.boolean(),
 run:z.object({runId:id,reviewRevisionId:id,idempotencyKey:id}).strict().nullable()
}).strict().superRefine((value,context)=>{
 if(value.canApprove&&(!value.review||value.run?.reviewRevisionId===value.review.revisionId)||value.review&&value.review.propertyId!==value.property?.id)context.addIssue({code:"custom",message:"actual_eligible_native_review_required"});
});
