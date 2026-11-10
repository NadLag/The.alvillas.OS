import {z} from "zod";
import {onboardingStepSchema,onboardingSteps} from "./onboarding-policy";
import {onboardingTeamMaximumAssignments} from "./onboarding-policy";
export const onboardingOwnerSchema=z.object({displayName:z.string(),email:z.string().nullable(),phone:z.string().nullable(),preferredLocale:z.enum(["en","fr","ar"])}).strict();

export const onboardingIdSchema=z.uuid().transform(value=>value.toLowerCase());
export const onboardingFingerprintSchema=z.string().regex(/^[a-f0-9]{64}$/u);
export const onboardingCommandFields={idempotencyKey:onboardingIdSchema,reviewFingerprint:onboardingFingerprintSchema,reason:z.string().trim().min(1).max(1000)};
export const onboardingTeamOptionsSchema=z.object({revisionId:onboardingIdSchema,propertyId:onboardingIdSchema,propertyName:z.string(),modes:z.array(z.enum(["LINK","ASSIGN"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimumAssignments:z.number().int().min(0).max(onboardingTeamMaximumAssignments)}).strict();
export const onboardingReceiptSchema=z.object({id:onboardingIdSchema,sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema.nullable(),number:z.number().int().positive(),step:onboardingStepSchema,ownerId:onboardingIdSchema,propertyId:onboardingIdSchema.nullable(),createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export function onboardingProgressMatches(value:{sessionId:string;current:z.infer<typeof onboardingReceiptSchema>;selected:z.infer<typeof onboardingReceiptSchema>;history:z.infer<typeof onboardingReceiptSchema>[];completed:z.infer<typeof onboardingStepSchema>[];nextStep:z.infer<typeof onboardingStepSchema>|null}){
 return value.current.sessionId===value.sessionId&&value.selected.sessionId===value.sessionId&&value.history.every(item=>item.sessionId===value.sessionId)&&value.completed.at(-1)===value.current.step&&JSON.stringify(value.completed)===JSON.stringify(onboardingSteps.slice(0,value.completed.length))&&value.nextStep===(onboardingSteps[value.completed.length]??null);
}
