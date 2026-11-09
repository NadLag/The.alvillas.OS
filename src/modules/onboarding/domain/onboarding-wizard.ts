import {z} from "zod";
import {onboardingOwnerInputSchema} from "@/platform/onboarding/contracts";
import {onboardingStepSchema,onboardingSteps} from "./onboarding-policy";

export const onboardingMaximumRequestBytes=65536;
const uuid=z.uuid().transform(value=>value.toLowerCase()),sha256=z.string().regex(/^[a-f0-9]{64}$/u);
export const onboardingOwnerTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("CREATE"),input:onboardingOwnerInputSchema}).strict(),
 z.object({mode:z.literal("LINK"),ownerId:uuid}).strict()
]);
export const onboardingDraftSchema=z.object({sessionId:uuid.nullable(),previousRevisionId:uuid.nullable(),step:z.literal("OWNER"),target:onboardingOwnerTargetSchema}).strict().refine(value=>(value.sessionId===null)===(value.previousRevisionId===null));
export const onboardingCommandSchema=onboardingDraftSchema.safeExtend({idempotencyKey:uuid,reviewFingerprint:sha256,reason:z.string().trim().min(1).max(1000)});
export type OnboardingDraft=z.infer<typeof onboardingDraftSchema>;
export type OnboardingCommand=z.infer<typeof onboardingCommandSchema>;
export const onboardingOwnerSchema=z.object({displayName:z.string(),email:z.string().nullable(),phone:z.string().nullable(),preferredLocale:z.enum(["en","fr","ar"])}).strict();
export const onboardingReceiptSchema=z.object({id:uuid,sessionId:uuid,previousRevisionId:uuid.nullable(),number:z.number().int().positive(),step:onboardingStepSchema,ownerId:uuid,propertyId:uuid.nullable(),createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export const onboardingReviewSchema=z.object({draft:onboardingDraftSchema,owner:onboardingOwnerSchema,reviewFingerprint:sha256}).strict();
export const onboardingReadInputSchema=z.object({sessionId:uuid,revisionId:uuid.optional(),before:z.number().int().positive().optional()}).strict();
export const onboardingReadSchema=z.object({sessionId:uuid,current:onboardingReceiptSchema,selected:onboardingReceiptSchema,owner:onboardingOwnerSchema,reason:z.string(),history:z.array(onboardingReceiptSchema).max(20),next:z.number().int().positive().nullable(),completed:z.array(onboardingStepSchema),nextStep:onboardingStepSchema.nullable()}).strict().superRefine((value,context)=>{
 if(value.current.sessionId!==value.sessionId||value.selected.sessionId!==value.sessionId||value.history.some(item=>item.sessionId!==value.sessionId)||value.completed.at(-1)!==value.current.step||JSON.stringify(value.completed)!==JSON.stringify(onboardingSteps.slice(0,value.completed.length))||value.nextStep!==(onboardingSteps[value.completed.length]??null))context.addIssue({code:"custom",message:"native_onboarding_progress_required"});
});
export const onboardingRecoverySchema=z.object({recorded:z.boolean(),revision:onboardingReceiptSchema.nullable()}).strict().refine(value=>value.recorded===(value.revision!==null));
export const onboardingDirectorySchema=z.object({items:z.array(onboardingReceiptSchema).max(20),next:z.string().nullable()}).strict();
export const onboardingChoicesInputSchema=z.object({sessionId:uuid.optional(),query:z.string().trim().max(160).default(""),cursor:z.string().min(1).max(6000).optional()}).strict();
export const onboardingChoicesSchema=z.object({owners:z.array(z.object({id:uuid,displayName:z.string(),email:z.string().nullable()}).strict()).max(20),next:z.string().nullable()}).strict();
export const onboardingOptionsSchema=z.object({canView:z.boolean(),canCreate:z.boolean(),canEdit:z.boolean(),modes:z.array(z.enum(["CREATE","LINK"])).max(2),steps:z.array(onboardingStepSchema).length(onboardingSteps.length)}).strict();

export function canonicalOnboardingDraft(raw:unknown):OnboardingDraft{
 const value=onboardingDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"OWNER",target:value.target};
}
export function canonicalOnboardingCommand(raw:unknown):OnboardingCommand{
 const value=onboardingCommandSchema.parse(raw);return{...canonicalOnboardingDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
export class OnboardingAccessError extends Error{constructor(){super("onboarding_not_authorized");}}
export class OnboardingConflictError extends Error{constructor(){super("onboarding_source_changed");}}
export class OnboardingConfigurationError extends Error{constructor(){super("onboarding_configuration_unavailable");}}
export class OnboardingRateLimitError extends Error{constructor(readonly resetAt:Date){super("onboarding_rate_limited");}}
