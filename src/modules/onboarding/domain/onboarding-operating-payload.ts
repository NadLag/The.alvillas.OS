import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {parseConfigRuleValue} from "@/platform/config/rule-registry";
import {onboardingOperatingProfileSnapshotSchema} from "@/platform/onboarding/contracts";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingOwnerSchema,OnboardingConfigurationError,onboardingMaximumRequestBytes} from "./onboarding-wizard";
import {onboardingPropertySnapshotSchema} from "./onboarding-property";
import {canonicalOnboardingOperatingCommand,canonicalOnboardingOperatingDraft,onboardingOperatingReviewSchema,type OnboardingOperatingCommand} from "./onboarding-operating-profile";

const bindingSchema=onboardingPayloadBindingSchema.extend({propertyId:z.uuid().transform(value=>value.toLowerCase())}).strict();
export type OnboardingOperatingPayloadBinding=z.infer<typeof bindingSchema>;
export const onboardingMaximumOperatingPayloadBytes=onboardingMaximumRequestBytes*3;
export const onboardingOperatingRuleSnapshotSchema=z.object({id:z.uuid().transform(value=>value.toLowerCase()),key:z.literal("ops.mid_stay_threshold"),version:z.number().int().positive(),value:z.unknown()}).strict().superRefine((value,context)=>{try{parseConfigRuleValue(value.key,value.value);}catch{context.addIssue({code:"custom",message:"native_onboarding_original_operating_rule_required"});}});
const payloadSchema=z.object({command:z.unknown(),originalOwner:onboardingOwnerSchema,originalProperty:onboardingPropertySnapshotSchema,previousOperatingProfile:onboardingOperatingProfileSnapshotSchema.nullable(),originalOperatingProfile:onboardingOperatingProfileSnapshotSchema,operatingRule:onboardingOperatingRuleSnapshotSchema.nullable()}).strict();
type OriginalFields=Omit<z.infer<typeof payloadSchema>,"command">;
type PayloadInput=OriginalFields&{command:OnboardingOperatingCommand};
function context(raw:OnboardingOperatingPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-property-onboarding-operating-v1",b.organizationId,b.sessionId,b.revisionId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:OnboardingOperatingPayloadBinding){
 const value=payloadSchema.parse(raw),command=canonicalOnboardingOperatingCommand(value.command),b=bindingSchema.parse(binding);
 if(command.sessionId!==b.sessionId||command.idempotencyKey!==b.commandKey||command.target.propertyId!==b.propertyId||value.originalProperty.id!==b.propertyId||!["DRAFT","ONBOARDING"].includes(value.originalProperty.status))throw new OnboardingConfigurationError();
 onboardingOperatingReviewSchema.parse({draft:canonicalOnboardingOperatingDraft({sessionId:command.sessionId,previousRevisionId:command.previousRevisionId,step:command.step,target:command.target}),owner:value.originalOwner,property:value.originalProperty,previousOperatingProfile:value.previousOperatingProfile,operatingProfile:value.originalOperatingProfile,reviewFingerprint:command.reviewFingerprint});
 if(value.originalOperatingProfile.midStayCleaningEnabled){if(!value.operatingRule||value.originalOperatingProfile.midStayCleaningRuleKey!==value.operatingRule.key)throw new OnboardingConfigurationError();}else if(value.operatingRule!==null)throw new OnboardingConfigurationError();
 return{command,originalOwner:value.originalOwner,originalProperty:value.originalProperty,previousOperatingProfile:value.previousOperatingProfile,originalOperatingProfile:value.originalOperatingProfile,operatingRule:value.operatingRule};
}
export function encryptOnboardingOperatingPayload(raw:PayloadInput,binding:OnboardingOperatingPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{if(plain.byteLength>onboardingMaximumOperatingPayloadBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(plain,context(binding),env);if(cipher.byteLength>onboardingMaximumOperatingPayloadBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{plain.fill(0);}
}
export function decryptOnboardingOperatingPayload(cipher:Uint8Array,binding:OnboardingOperatingPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>onboardingMaximumOperatingPayloadBytes)throw new OnboardingConfigurationError();const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
