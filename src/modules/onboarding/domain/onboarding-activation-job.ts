import {z} from "zod";
import {onboardingIdSchema as id} from "./onboarding-primitives";
import {onboardingActivationPolicySchema} from "./onboarding-activation-policy";
import {OnboardingConfigurationError} from "./onboarding-wizard";

export const onboardingActivationContinuationRequested="onboarding.activation_continue_requested";
export const onboardingActivationContinuationPrefix="onboarding.activation.continue:";
export const onboardingActivationJobReferenceSchema=z.object({organizationId:id,outboxEventId:id}).strict();
export const onboardingActivationRootJobPayloadSchema=z.object({sessionId:id,activationId:id,reviewRevisionId:id,propertyId:id}).strict();
export const onboardingActivationContinuationPayloadSchema=z.object({activationId:id,sourceOutboxEventId:id,activationHeadId:id,notBefore:z.iso.datetime().nullable()}).strict();
export const onboardingActivationJobTerminalHeads=new Set(["ACTIVATED","FAILED","BLOCKED"]);
export function onboardingActivationContinuationKey(sourceOutboxEventId:string){return onboardingActivationContinuationPrefix+id.parse(sourceOutboxEventId);}

/** Pending work uses only its captured approved retry policy and actual reset/retry time. */
export function onboardingActivationContinuationDue(rawPolicy:unknown,head:{type:string;nextAttemptAt:Date|null},now:Date,requestedNextAttemptAt?:string|null){
 const policy=onboardingActivationPolicySchema.parse(rawPolicy);if(!Number.isFinite(now.getTime())||onboardingActivationJobTerminalHeads.has(head.type))throw new OnboardingConfigurationError();
 let minimum:number|null=null;
 if(head.type==="STARTED")minimum=now.getTime()+policy.retry.backoff_seconds*1000;
 else if(head.type==="RETRY_SCHEDULED"){if(!head.nextAttemptAt||!Number.isFinite(head.nextAttemptAt.getTime()))throw new OnboardingConfigurationError();minimum=head.nextAttemptAt>now?head.nextAttemptAt.getTime():null;}
 else if(!["REQUESTED","SUCCEEDED"].includes(head.type))throw new OnboardingConfigurationError();
 if(requestedNextAttemptAt){const value=z.iso.datetime().parse(requestedNextAttemptAt),date=new Date(value);if(date>now)minimum=Math.max(minimum??0,date.getTime());}
 return minimum===null?null:new Date(minimum);
}
