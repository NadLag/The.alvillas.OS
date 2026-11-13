import {z} from "zod";
import {configSlugSchema} from "@/platform/config/identifiers";
import {onboardingIdSchema as id,onboardingFingerprintSchema as fingerprint} from "./onboarding-primitives";
import {onboardingOwnerDeliveryReceiptSchema} from "./onboarding-owner-delivery";

export const onboardingActivationEffectProtocol="NATIVE_ONBOARDING_ACTIVATION_EFFECT_V1";
const base=z.object({protocol:z.literal(onboardingActivationEffectProtocol),activationId:id});
const workflow=z.object({workflowKey:configSlugSchema,key:z.string().regex(/^automation\.rule\.onb_[a-f0-9]{48}$/u),ruleId:id,version:z.number().int().positive(),fingerprint}).strict();
const task=z.object({key:configSlugSchema,taskId:id,commandKey:id}).strict();
export const onboardingWorkflowEffectEvidenceSchema=base.extend({effectKind:z.literal("WORKFLOWS"),sourceRuleId:id,sourceFingerprint:fingerprint,workflows:z.array(workflow).max(100).refine(items=>["workflowKey","key","ruleId"].every(key=>new Set(items.map(item=>item[key as keyof typeof item])).size===items.length))}).strict();
export const onboardingDocumentsEffectEvidenceSchema=base.extend({effectKind:z.literal("DOCUMENTS"),packageId:id}).strict();
export const onboardingEmailEffectEvidenceSchema=base.extend({effectKind:z.literal("EMAIL"),ownerDeliveryId:id,deliveryRecordId:id,acceptedAt:z.iso.datetime()}).strict();
export const onboardingTasksEffectEvidenceSchema=base.extend({effectKind:z.literal("TASKS"),sourceRuleId:id,sourceFingerprint:fingerprint,tasks:z.array(task).max(100).refine(items=>["key","taskId","commandKey"].every(key=>new Set(items.map(item=>item[key as keyof typeof item])).size===items.length))}).strict();
export const onboardingNotificationEffectEvidenceSchema=base.extend({effectKind:z.literal("NOTIFICATION"),ownerDeliveryId:id,deliveryRecordId:id,deliveredAt:z.iso.datetime()}).strict();
export const onboardingActivationEffectEvidenceSchema=z.discriminatedUnion("effectKind",[onboardingWorkflowEffectEvidenceSchema,onboardingDocumentsEffectEvidenceSchema,onboardingEmailEffectEvidenceSchema,onboardingTasksEffectEvidenceSchema,onboardingNotificationEffectEvidenceSchema]);
export type OnboardingActivationEffectEvidence=z.infer<typeof onboardingActivationEffectEvidenceSchema>;

/** Provider acceptance and verified owner delivery are distinct actual milestones of the same canonical message. */
export function activationOwnerEmailMilestones(activationId:string,raw:unknown){
 const binding=id.parse(activationId),receipt=onboardingOwnerDeliveryReceiptSchema.parse(raw),reference={protocol:onboardingActivationEffectProtocol,activationId:binding,ownerDeliveryId:receipt.id,deliveryRecordId:receipt.deliveryRecordId};
 if(!["PENDING","ACCEPTED","DELIVERED"].includes(receipt.state))return{email:null,notification:null,waiting:false,blockedCode:"OWNER_EMAIL_"+receipt.state};
 if(receipt.state==="PENDING")return{email:null,notification:null,waiting:true,blockedCode:null};
 const email=onboardingEmailEffectEvidenceSchema.parse({...reference,effectKind:"EMAIL",acceptedAt:receipt.acceptedAt}),notification=receipt.state==="DELIVERED"?onboardingNotificationEffectEvidenceSchema.parse({...reference,effectKind:"NOTIFICATION",deliveredAt:receipt.deliveredAt}):null;
 return{email,notification,waiting:notification===null,blockedCode:null};
}
