import {z} from "zod";
import {onboardingDraftSchema,onboardingCommandSchema,onboardingReviewSchema,onboardingReadSchema,canonicalOnboardingDraft,canonicalOnboardingCommand} from "./onboarding-wizard";
import {onboardingPropertyDraftSchema,onboardingPropertyCommandSchema,onboardingPropertyReviewSchema,onboardingPropertyReadSchema,canonicalOnboardingPropertyDraft,canonicalOnboardingPropertyCommand} from "./onboarding-property";
import {onboardingOperatingDraftSchema,onboardingOperatingCommandSchema,onboardingOperatingReviewSchema,onboardingOperatingReadSchema,canonicalOnboardingOperatingDraft,canonicalOnboardingOperatingCommand} from "./onboarding-operating-profile";

export const onboardingRecordDraftSchema=z.discriminatedUnion("step",[onboardingDraftSchema,onboardingPropertyDraftSchema,onboardingOperatingDraftSchema]);
export const onboardingRecordCommandSchema=z.discriminatedUnion("step",[onboardingCommandSchema,onboardingPropertyCommandSchema,onboardingOperatingCommandSchema]);
export const onboardingRecordReviewSchema=z.union([onboardingReviewSchema,onboardingPropertyReviewSchema,onboardingOperatingReviewSchema]);
export const onboardingRecordSchema=z.union([onboardingReadSchema,onboardingPropertyReadSchema,onboardingOperatingReadSchema]);
export type OnboardingRecordDraft=z.infer<typeof onboardingRecordDraftSchema>;
export type OnboardingRecordCommand=z.infer<typeof onboardingRecordCommandSchema>;
export function canonicalOnboardingRecordDraft(raw:unknown){const value=onboardingRecordDraftSchema.parse(raw);return value.step==="OWNER"?canonicalOnboardingDraft(value):value.step==="PROPERTY"?canonicalOnboardingPropertyDraft(value):canonicalOnboardingOperatingDraft(value);}
export function canonicalOnboardingRecordCommand(raw:unknown){const value=onboardingRecordCommandSchema.parse(raw);return value.step==="OWNER"?canonicalOnboardingCommand(value):value.step==="PROPERTY"?canonicalOnboardingPropertyCommand(value):canonicalOnboardingOperatingCommand(value);}
