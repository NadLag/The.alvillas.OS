import {z} from "zod";
import {onboardingPropertyInputSchema,onboardingPropertyStatusSchema,parseConfiguredOnboardingPropertyProfile} from "@/platform/onboarding/contracts";
import {onboardingCommandFields,onboardingIdSchema,onboardingFingerprintSchema,onboardingOwnerSchema,onboardingReceiptSchema,onboardingProgressMatches} from "./onboarding-contract";
import {onboardingStepSchema} from "./onboarding-policy";

export const onboardingPropertyTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("CREATE"),input:onboardingPropertyInputSchema}).strict(),
 z.object({mode:z.literal("LINK"),propertyId:onboardingIdSchema}).strict()
]);
export const onboardingPropertyDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("PROPERTY"),target:onboardingPropertyTargetSchema}).strict();
export const onboardingPropertyCommandSchema=onboardingPropertyDraftSchema.extend(onboardingCommandFields);
export type OnboardingPropertyDraft=z.infer<typeof onboardingPropertyDraftSchema>;
export type OnboardingPropertyCommand=z.infer<typeof onboardingPropertyCommandSchema>;

/** Historical physical values are explicit; neither configuration defaults nor financial fields are projected here. */
export const onboardingPropertySnapshotSchema=z.object({
 id:onboardingIdSchema,name:z.string(),addressLine1:z.string(),addressLine2:z.string().nullable(),
 cityId:onboardingIdSchema.nullable(),regionId:onboardingIdSchema.nullable(),city:z.string(),region:z.string().nullable(),countryCode:z.string(),propertyType:z.string(),
 bedrooms:z.number().int().nonnegative(),bathrooms:z.number().int().nonnegative(),livingSpaces:z.number().int().nonnegative(),parkingSpaces:z.number().int().nonnegative(),maxGuests:z.number().int().positive(),
 hasPool:z.boolean(),hasGarden:z.boolean(),timezone:z.string(),amenities:z.array(z.string()),photoUrls:z.array(z.string()),status:onboardingPropertyStatusSchema
}).strict();
export type OnboardingPropertySnapshot=z.infer<typeof onboardingPropertySnapshotSchema>;
export const onboardingPropertyChoicesInputSchema=z.object({sessionId:onboardingIdSchema,query:z.string().trim().max(160).default(""),cursor:z.string().min(1).max(6000).optional()}).strict();
export const onboardingPropertyChoicesSchema=z.object({properties:z.array(onboardingPropertySnapshotSchema.pick({id:true,name:true,addressLine1:true,city:true,status:true})).max(20),next:z.string().nullable()}).strict();
export const onboardingPropertyReviewSchema=z.object({draft:onboardingPropertyDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema.nullable(),reviewFingerprint:onboardingFingerprintSchema}).strict().superRefine((value,context)=>{
 if(value.draft.target.mode==="CREATE"?value.property!==null:value.property?.id!==value.draft.target.propertyId)context.addIssue({code:"custom",message:"native_onboarding_property_review_source_required"});
});
export const onboardingPropertyReadSchema=z.object({sessionId:onboardingIdSchema,current:onboardingReceiptSchema,selected:onboardingReceiptSchema,draft:onboardingPropertyDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema,initialOperatingProfile:z.record(z.string(),z.unknown()).nullable(),reason:z.string(),history:z.array(onboardingReceiptSchema).max(20),next:z.number().int().positive().nullable(),completed:z.array(onboardingStepSchema),nextStep:onboardingStepSchema.nullable()}).strict().superRefine((value,context)=>{
 if(!onboardingProgressMatches(value))context.addIssue({code:"custom",message:"native_onboarding_progress_required"});
 if(value.selected.step!=="PROPERTY"||value.selected.propertyId!==value.property.id||value.draft.sessionId!==value.sessionId||value.draft.previousRevisionId!==value.selected.previousRevisionId||value.draft.target.mode==="LINK"&&value.draft.target.propertyId!==value.property.id||value.draft.target.mode==="CREATE"&&value.draft.target.input.ownerId!==value.selected.ownerId)context.addIssue({code:"custom",message:"native_onboarding_property_recorded_source_required"});
 if(value.draft.target.mode==="LINK"){if(value.initialOperatingProfile!==null)context.addIssue({code:"custom",message:"native_onboarding_linked_property_configuration_required"});}else{try{parseConfiguredOnboardingPropertyProfile(value.initialOperatingProfile);}catch{context.addIssue({code:"custom",message:"native_onboarding_original_operating_configuration_required"});}}
});

export function canonicalOnboardingPropertyDraft(raw:unknown):OnboardingPropertyDraft{
 const value=onboardingPropertyDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"PROPERTY",target:value.target};
}
export function canonicalOnboardingPropertyCommand(raw:unknown):OnboardingPropertyCommand{
 const value=onboardingPropertyCommandSchema.parse(raw);return{...canonicalOnboardingPropertyDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
