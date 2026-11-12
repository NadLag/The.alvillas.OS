import {z} from "zod";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
export {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
import {onboardingStepSchema,onboardingSteps} from "./onboarding-policy";
import {onboardingTeamMaximumAssignments,onboardingBookingChannelsMaximum} from "./onboarding-policy";
import {onboardingInventoryMaximumItems} from "@/platform/onboarding/contracts";
export const onboardingOwnerSchema=z.object({displayName:z.string(),email:z.string().nullable(),phone:z.string().nullable(),preferredLocale:z.enum(["en","fr","ar"])}).strict();

export const onboardingCommandFields={idempotencyKey:onboardingIdSchema,reviewFingerprint:onboardingFingerprintSchema,reason:z.string().trim().min(1).max(1000)};
export const onboardingConfigurationOptionsSchema=z.object({revisionId:onboardingIdSchema,propertyId:onboardingIdSchema,modes:z.array(z.literal("VALIDATE")).length(1)}).strict();
export const onboardingTeamOptionsSchema=z.object({revisionId:onboardingIdSchema,propertyId:onboardingIdSchema,propertyName:z.string(),modes:z.array(z.enum(["LINK","ASSIGN"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimumAssignments:z.number().int().min(0).max(onboardingTeamMaximumAssignments)}).strict();
export const onboardingBookingChannelsOptionsSchema=z.object({revisionId:onboardingIdSchema,propertyId:onboardingIdSchema,propertyName:z.string(),modes:z.array(z.enum(["LINK","CONFIGURE"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimumChannels:z.number().int().min(0).max(onboardingBookingChannelsMaximum)}).strict();
export const onboardingInventoryOptionsSchema=z.object({revisionId:onboardingIdSchema,propertyId:onboardingIdSchema,propertyName:z.string(),modes:z.array(z.enum(["TEMPLATE","CUSTOM"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimumItems:z.number().int().min(0).max(onboardingInventoryMaximumItems),expectedTemplateRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const onboardingReceiptSchema=z.object({id:onboardingIdSchema,sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema.nullable(),number:z.number().int().positive(),step:onboardingStepSchema,ownerId:onboardingIdSchema,propertyId:onboardingIdSchema.nullable(),createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export function onboardingProgressMatches(value:{sessionId:string;current:z.infer<typeof onboardingReceiptSchema>;selected:z.infer<typeof onboardingReceiptSchema>;history:z.infer<typeof onboardingReceiptSchema>[];completed:z.infer<typeof onboardingStepSchema>[];nextStep:z.infer<typeof onboardingStepSchema>|null}){
 return value.current.sessionId===value.sessionId&&value.selected.sessionId===value.sessionId&&value.history.every(item=>item.sessionId===value.sessionId)&&value.completed.at(-1)===value.current.step&&JSON.stringify(value.completed)===JSON.stringify(onboardingSteps.slice(0,value.completed.length))&&value.nextStep===(onboardingSteps[value.completed.length]??null);
}
