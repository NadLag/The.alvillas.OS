import {z} from "zod";
import {onboardingIdSchema,onboardingFingerprintSchema,onboardingCommandFields} from "./onboarding-contract";
import {onboardingConfigurationValidationSchema} from "./onboarding-configuration";

export const onboardingConfigurationDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("REVIEW"),target:z.object({mode:z.literal("VALIDATE"),propertyId:onboardingIdSchema}).strict()}).strict();
export type OnboardingConfigurationDraft=z.infer<typeof onboardingConfigurationDraftSchema>;
export const onboardingConfigurationCommandSchema=onboardingConfigurationDraftSchema.extend(onboardingCommandFields);
export type OnboardingConfigurationCommand=z.infer<typeof onboardingConfigurationCommandSchema>;
export const onboardingConfigurationReviewSchema=z.object({draft:onboardingConfigurationDraftSchema,validation:onboardingConfigurationValidationSchema,reviewFingerprint:onboardingFingerprintSchema}).strict().refine(value=>value.draft.sessionId===value.validation.facts.sessionId&&value.draft.target.propertyId===value.validation.facts.propertyId);
