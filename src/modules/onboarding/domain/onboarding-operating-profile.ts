import {z} from "zod";
import {onboardingOperatingProfileInputSchema,onboardingOperatingProfileSnapshotSchema} from "@/platform/onboarding/contracts";
import {onboardingIdSchema,onboardingFingerprintSchema,onboardingCommandFields,onboardingOwnerSchema,onboardingReceiptSchema,onboardingProgressMatches} from "./onboarding-contract";
import {onboardingPropertySnapshotSchema} from "./onboarding-property";
import {onboardingStepSchema} from "./onboarding-policy";

export const onboardingOperatingTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("LINK"),propertyId:onboardingIdSchema}).strict(),
 z.object({mode:z.literal("UPDATE"),propertyId:onboardingIdSchema,input:onboardingOperatingProfileInputSchema}).strict()
]);
export const onboardingOperatingDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("OPERATING_PROFILE"),target:onboardingOperatingTargetSchema}).strict();
export const onboardingOperatingCommandSchema=onboardingOperatingDraftSchema.extend(onboardingCommandFields);
export type OnboardingOperatingDraft=z.infer<typeof onboardingOperatingDraftSchema>;
export type OnboardingOperatingCommand=z.infer<typeof onboardingOperatingCommandSchema>;
export type OnboardingOperatingProfile=z.infer<typeof onboardingOperatingProfileSnapshotSchema>;
export function nativeOperatingProfileSnapshot(raw:unknown):OnboardingOperatingProfile{return onboardingOperatingProfileSnapshotSchema.parse(raw);}
export function proposedNativeOperatingProfile(input:Extract<OnboardingOperatingDraft["target"],{mode:"UPDATE"}>["input"]):OnboardingOperatingProfile{return nativeOperatingProfileSnapshot({...input,midStayCleaningRuleKey:input.midStayCleaningRuleKey??null,automationNotes:input.automationNotes??null});}

const originalFields={draft:onboardingOperatingDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema,previousOperatingProfile:onboardingOperatingProfileSnapshotSchema.nullable(),operatingProfile:onboardingOperatingProfileSnapshotSchema};
function originalsMatch(value:z.infer<z.ZodObject<typeof originalFields>>){
 if(value.draft.target.propertyId!==value.property.id)return false;
 // Both projections have Core's canonical field order and explicit nullable fields.
 return value.draft.target.mode==="LINK"?value.previousOperatingProfile!==null&&JSON.stringify(value.previousOperatingProfile)===JSON.stringify(value.operatingProfile):JSON.stringify(proposedNativeOperatingProfile(value.draft.target.input))===JSON.stringify(value.operatingProfile);
}
export const onboardingOperatingReviewSchema=z.object({...originalFields,reviewFingerprint:onboardingFingerprintSchema}).strict().refine(originalsMatch,{message:"native_onboarding_operating_review_source_required"});
export const onboardingOperatingReadSchema=z.object({...originalFields,sessionId:onboardingIdSchema,current:onboardingReceiptSchema,selected:onboardingReceiptSchema,reason:z.string(),history:z.array(onboardingReceiptSchema).max(20),next:z.number().int().positive().nullable(),completed:z.array(onboardingStepSchema),nextStep:onboardingStepSchema.nullable()}).strict().superRefine((value,context)=>{
 if(!originalsMatch(value)||!onboardingProgressMatches(value)||value.selected.step!=="OPERATING_PROFILE"||value.selected.propertyId!==value.property.id||value.draft.sessionId!==value.sessionId||value.draft.previousRevisionId!==value.selected.previousRevisionId)context.addIssue({code:"custom",message:"native_onboarding_original_operating_history_required"});
});
export function canonicalOnboardingOperatingDraft(raw:unknown):OnboardingOperatingDraft{const value=onboardingOperatingDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"OPERATING_PROFILE",target:value.target};}
export function canonicalOnboardingOperatingCommand(raw:unknown):OnboardingOperatingCommand{const value=onboardingOperatingCommandSchema.parse(raw);return{...canonicalOnboardingOperatingDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};}
