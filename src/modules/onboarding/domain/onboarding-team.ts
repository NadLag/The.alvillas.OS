import {z} from "zod";
import {onboardingTeamAssignmentInputSchema,onboardingTeamAssignmentReasonSchema} from "@/platform/onboarding/contracts";
import {onboardingIdSchema,onboardingCommandFields} from "./onboarding-contract";
import {onboardingTeamMaximumAssignments} from "./onboarding-policy";

export const onboardingTeamTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("LINK"),propertyId:onboardingIdSchema,assignmentIds:z.array(onboardingIdSchema).max(onboardingTeamMaximumAssignments).refine(values=>new Set(values).size===values.length)}).strict(),
 z.object({mode:z.literal("ASSIGN"),propertyId:onboardingIdSchema,assignments:z.array(onboardingTeamAssignmentInputSchema).min(1).max(onboardingTeamMaximumAssignments).refine(values=>new Set(values.map(value=>JSON.stringify(value))).size===values.length)}).strict()
]);
export const onboardingTeamDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("TEAM"),target:onboardingTeamTargetSchema}).strict();
export const onboardingTeamCommandSchema=onboardingTeamDraftSchema.extend({...onboardingCommandFields,reason:onboardingTeamAssignmentReasonSchema});
export type OnboardingTeamDraft=z.infer<typeof onboardingTeamDraftSchema>;
export type OnboardingTeamCommand=z.infer<typeof onboardingTeamCommandSchema>;
export function canonicalOnboardingTeamDraft(raw:unknown):OnboardingTeamDraft{
 const value=onboardingTeamDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"TEAM",target:value.target};
}
export function canonicalOnboardingTeamCommand(raw:unknown):OnboardingTeamCommand{
 const value=onboardingTeamCommandSchema.parse(raw);return{...canonicalOnboardingTeamDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
