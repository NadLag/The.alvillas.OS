import {z} from "zod";
import {onboardingPropertyInputSchema,onboardingPropertyStatusSchema} from "@/platform/onboarding/contracts";
import {onboardingCommandFields,onboardingIdSchema} from "./onboarding-contract";

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

export function canonicalOnboardingPropertyDraft(raw:unknown):OnboardingPropertyDraft{
 const value=onboardingPropertyDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"PROPERTY",target:value.target};
}
export function canonicalOnboardingPropertyCommand(raw:unknown):OnboardingPropertyCommand{
 const value=onboardingPropertyCommandSchema.parse(raw);return{...canonicalOnboardingPropertyDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
