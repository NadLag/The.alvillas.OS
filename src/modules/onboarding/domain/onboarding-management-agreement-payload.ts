import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {parseConfigRuleValue} from "@/platform/config/rule-registry";
import {nativeOnboardingManagementAgreementRuleValues} from "@/platform/onboarding/contracts";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingOwnerSchema,OnboardingConfigurationError,onboardingMaximumRequestBytes} from "./onboarding-wizard";
import {onboardingPropertySnapshotSchema} from "./onboarding-property";
import {canonicalOnboardingManagementAgreementCommand,onboardingManagementAgreementSnapshotSchema,type OnboardingManagementAgreementCommand} from "./onboarding-management-agreement";

const bindingSchema=onboardingPayloadBindingSchema.extend({propertyId:z.uuid().transform(value=>value.toLowerCase()),agreementId:z.uuid().transform(value=>value.toLowerCase())}).strict();
export type OnboardingManagementAgreementPayloadBinding=z.infer<typeof bindingSchema>;
// Keep the existing non-Owner technical envelope; history cannot expand a public command bound.
export const onboardingMaximumManagementAgreementPayloadBytes=onboardingMaximumRequestBytes*3;
const payloadSchema=z.object({command:z.unknown(),originalOwner:onboardingOwnerSchema,originalProperty:onboardingPropertySnapshotSchema,previousAgreement:onboardingManagementAgreementSnapshotSchema.nullable(),originalAgreement:onboardingManagementAgreementSnapshotSchema}).strict();
type PayloadInput=Omit<z.infer<typeof payloadSchema>,"command">&{command:OnboardingManagementAgreementCommand};
function context(raw:OnboardingManagementAgreementPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-property-onboarding-management-agreement-v1",b.organizationId,b.sessionId,b.revisionId,b.ownerId,b.propertyId,b.agreementId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:OnboardingManagementAgreementPayloadBinding){
 const value=payloadSchema.parse(raw),command=canonicalOnboardingManagementAgreementCommand(value.command),b=bindingSchema.parse(binding),agreement=value.originalAgreement;
 if(command.sessionId!==b.sessionId||command.idempotencyKey!==b.commandKey||command.target.propertyId!==b.propertyId||value.originalProperty.id!==b.propertyId||!["DRAFT","ONBOARDING"].includes(value.originalProperty.status)||agreement.id!==b.agreementId||agreement.propertyId!==b.propertyId||!["DRAFT","ACTIVE"].includes(agreement.status))throw new OnboardingConfigurationError();
 for(const rule of agreement.rules)parseConfigRuleValue(rule.key,rule.value);
 if(command.target.mode==="LINK"){
  if(command.target.agreementId!==b.agreementId||value.previousAgreement===null||commandFingerprint(value.previousAgreement)!==commandFingerprint(agreement))throw new OnboardingConfigurationError();
 }else{
  const input=command.target.input,expected=nativeOnboardingManagementAgreementRuleValues({...input,approvalThresholdKey:input.approvalThresholdKey??undefined,approvalThresholdAmount:input.approvalThresholdAmount??undefined}).map(rule=>({...rule,value:parseConfigRuleValue(rule.key,rule.value)}));
  if(value.previousAgreement!==null||agreement.status!=="DRAFT"||agreement.reference!==input.reference||agreement.effectiveFrom!==input.effectiveFrom||agreement.effectiveTo!==input.effectiveTo||agreement.rules.some(rule=>{const original=expected.find(item=>item.key===rule.key);return!original||rule.version!==1||rule.lifecycle!=="DRAFT"||rule.effectiveFrom!==input.effectiveFrom||rule.effectiveTo!==input.effectiveTo||rule.reason!==command.reason||!isDeepStrictEqual(rule.value,original.value);}))throw new OnboardingConfigurationError();
 }
 return{command,originalOwner:value.originalOwner,originalProperty:value.originalProperty,previousAgreement:value.previousAgreement,originalAgreement:agreement};
}
export function encryptOnboardingManagementAgreementPayload(raw:PayloadInput,binding:OnboardingManagementAgreementPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{if(plain.byteLength>onboardingMaximumManagementAgreementPayloadBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(plain,context(binding),env);if(cipher.byteLength>onboardingMaximumManagementAgreementPayloadBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{plain.fill(0);}
}
export function decryptOnboardingManagementAgreementPayload(cipher:Uint8Array,binding:OnboardingManagementAgreementPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>onboardingMaximumManagementAgreementPayloadBytes)throw new OnboardingConfigurationError();const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
