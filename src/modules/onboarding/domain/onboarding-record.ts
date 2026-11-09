import {z} from "zod";
import {onboardingDraftSchema,onboardingCommandSchema,onboardingReviewSchema,onboardingReadSchema,canonicalOnboardingDraft,canonicalOnboardingCommand} from "./onboarding-wizard";
import {onboardingPropertyDraftSchema,onboardingPropertyCommandSchema,onboardingPropertyReviewSchema,onboardingPropertyReadSchema,canonicalOnboardingPropertyDraft,canonicalOnboardingPropertyCommand} from "./onboarding-property";

export const onboardingRecordDraftSchema=z.discriminatedUnion("step",[onboardingDraftSchema,onboardingPropertyDraftSchema]);
export const onboardingRecordCommandSchema=z.discriminatedUnion("step",[onboardingCommandSchema,onboardingPropertyCommandSchema]);
export const onboardingRecordReviewSchema=z.union([onboardingReviewSchema,onboardingPropertyReviewSchema]);
export const onboardingRecordSchema=z.union([onboardingReadSchema,onboardingPropertyReadSchema]);
export type OnboardingRecordDraft=z.infer<typeof onboardingRecordDraftSchema>;
export type OnboardingRecordCommand=z.infer<typeof onboardingRecordCommandSchema>;
export function canonicalOnboardingRecordDraft(raw:unknown){const value=onboardingRecordDraftSchema.parse(raw);return value.step==="OWNER"?canonicalOnboardingDraft(value):canonicalOnboardingPropertyDraft(value);}
export function canonicalOnboardingRecordCommand(raw:unknown){const value=onboardingRecordCommandSchema.parse(raw);return value.step==="OWNER"?canonicalOnboardingCommand(value):canonicalOnboardingPropertyCommand(value);}
