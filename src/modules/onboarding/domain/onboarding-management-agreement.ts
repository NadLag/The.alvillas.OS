import {z} from "zod";
import {onboardingManagementAgreementInputSchema,onboardingManagementAgreementReasonSchema,onboardingManagementAgreementRuleKeys} from "@/platform/onboarding/contracts";
import {onboardingIdSchema,onboardingCommandFields,onboardingOwnerSchema,onboardingFingerprintSchema,onboardingReceiptSchema,onboardingProgressMatches} from "./onboarding-contract";
import {onboardingPropertySnapshotSchema,onboardingPropertyChoicesInputSchema} from "./onboarding-property";
import {onboardingStepSchema} from "./onboarding-policy";

export const onboardingManagementAgreementTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("CREATE"),propertyId:onboardingIdSchema,input:onboardingManagementAgreementInputSchema}).strict(),
 z.object({mode:z.literal("LINK"),propertyId:onboardingIdSchema,agreementId:onboardingIdSchema}).strict()
]);
export const onboardingManagementAgreementDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("MANAGEMENT_AGREEMENT"),target:onboardingManagementAgreementTargetSchema}).strict();
export const onboardingManagementAgreementCommandSchema=onboardingManagementAgreementDraftSchema.extend({...onboardingCommandFields,reason:onboardingManagementAgreementReasonSchema});
export type OnboardingManagementAgreementDraft=z.infer<typeof onboardingManagementAgreementDraftSchema>;
export type OnboardingManagementAgreementCommand=z.infer<typeof onboardingManagementAgreementCommandSchema>;
export type OnboardingManagementAgreementInput=z.infer<typeof onboardingManagementAgreementInputSchema>;
export const onboardingManagementAgreementChoicesInputSchema=onboardingPropertyChoicesInputSchema.extend({previousRevisionId:onboardingIdSchema});
export const onboardingManagementAgreementChoicesSchema=z.object({agreements:z.array(z.object({id:onboardingIdSchema,propertyId:onboardingIdSchema,reference:z.string(),status:z.enum(["DRAFT","ACTIVE"]),effectiveFrom:z.iso.datetime(),effectiveTo:z.iso.datetime().nullable()}).strict()).max(20),next:z.string().nullable()}).strict();
export const onboardingManagementAgreementRuleSnapshotSchema=z.object({id:onboardingIdSchema,key:z.enum(onboardingManagementAgreementRuleKeys),version:z.number().int().positive(),lifecycle:z.enum(["DRAFT","ACTIVE","RETIRED"]),effectiveFrom:z.iso.datetime(),effectiveTo:z.iso.datetime().nullable(),createdAt:z.iso.datetime(),reason:z.string(),value:z.json()}).strict();
export const onboardingManagementAgreementSnapshotSchema=z.object({id:onboardingIdSchema,propertyId:onboardingIdSchema,reference:z.string(),status:z.enum(["DRAFT","ACTIVE","ENDED"]),effectiveFrom:z.iso.datetime(),effectiveTo:z.iso.datetime().nullable(),rules:z.array(onboardingManagementAgreementRuleSnapshotSchema).length(onboardingManagementAgreementRuleKeys.length)}).strict().refine(value=>new Set(value.rules.map(rule=>rule.key)).size===onboardingManagementAgreementRuleKeys.length);
export const onboardingManagementAgreementReviewSchema=z.object({draft:onboardingManagementAgreementDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema,agreement:onboardingManagementAgreementSnapshotSchema.nullable(),proposedTerms:onboardingManagementAgreementInputSchema.nullable(),reviewFingerprint:onboardingFingerprintSchema}).strict().refine(value=>value.draft.target.propertyId===value.property.id&&(value.draft.target.mode==="CREATE"?value.agreement===null&&JSON.stringify(value.proposedTerms)===JSON.stringify(value.draft.target.input):value.proposedTerms===null&&value.agreement?.id===value.draft.target.agreementId&&value.agreement.propertyId===value.property.id));
export const onboardingManagementAgreementReadSchema=z.object({sessionId:onboardingIdSchema,current:onboardingReceiptSchema,selected:onboardingReceiptSchema,draft:onboardingManagementAgreementDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema,previousAgreement:onboardingManagementAgreementSnapshotSchema.nullable(),agreement:onboardingManagementAgreementSnapshotSchema,reason:z.string(),history:z.array(onboardingReceiptSchema).max(20),next:z.number().int().positive().nullable(),completed:z.array(onboardingStepSchema),nextStep:onboardingStepSchema.nullable()}).strict().superRefine((value,context)=>{
 if(!onboardingProgressMatches(value)||value.selected.step!=="MANAGEMENT_AGREEMENT"||value.draft.sessionId!==value.sessionId||value.draft.previousRevisionId!==value.selected.previousRevisionId||value.selected.propertyId!==value.property.id||value.draft.target.propertyId!==value.property.id||value.agreement.propertyId!==value.property.id||value.draft.target.mode==="LINK"&&(value.draft.target.agreementId!==value.agreement.id||value.previousAgreement===null)||value.draft.target.mode==="CREATE"&&value.previousAgreement!==null)context.addIssue({code:"custom",message:"native_onboarding_original_management_agreement_required"});
});
export function canonicalOnboardingManagementAgreementDraft(raw:unknown):OnboardingManagementAgreementDraft{
 const value=onboardingManagementAgreementDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"MANAGEMENT_AGREEMENT",target:value.target};
}
export function canonicalOnboardingManagementAgreementCommand(raw:unknown):OnboardingManagementAgreementCommand{
 const value=onboardingManagementAgreementCommandSchema.parse(raw);return{...canonicalOnboardingManagementAgreementDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
