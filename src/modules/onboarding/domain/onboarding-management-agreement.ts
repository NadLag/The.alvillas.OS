import {z} from "zod";
import {onboardingManagementAgreementInputSchema,onboardingManagementAgreementReasonSchema} from "@/platform/onboarding/contracts";
import {onboardingIdSchema,onboardingCommandFields} from "./onboarding-contract";

export const onboardingManagementAgreementTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("CREATE"),propertyId:onboardingIdSchema,input:onboardingManagementAgreementInputSchema}).strict(),
 z.object({mode:z.literal("LINK"),propertyId:onboardingIdSchema,agreementId:onboardingIdSchema}).strict()
]);
export const onboardingManagementAgreementDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("MANAGEMENT_AGREEMENT"),target:onboardingManagementAgreementTargetSchema}).strict();
export const onboardingManagementAgreementCommandSchema=onboardingManagementAgreementDraftSchema.extend({...onboardingCommandFields,reason:onboardingManagementAgreementReasonSchema});
export type OnboardingManagementAgreementDraft=z.infer<typeof onboardingManagementAgreementDraftSchema>;
export type OnboardingManagementAgreementCommand=z.infer<typeof onboardingManagementAgreementCommandSchema>;
export type OnboardingManagementAgreementInput=z.infer<typeof onboardingManagementAgreementInputSchema>;
export function canonicalOnboardingManagementAgreementDraft(raw:unknown):OnboardingManagementAgreementDraft{
 const value=onboardingManagementAgreementDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"MANAGEMENT_AGREEMENT",target:value.target};
}
export function canonicalOnboardingManagementAgreementCommand(raw:unknown):OnboardingManagementAgreementCommand{
 const value=onboardingManagementAgreementCommandSchema.parse(raw);return{...canonicalOnboardingManagementAgreementDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
