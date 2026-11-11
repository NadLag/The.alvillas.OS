import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {authorizationCapSchema} from "@/platform/authz/authorization-cap";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {onboardingMaximumConfigurationRecordBytes} from "@/platform/onboarding/limits";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-contract";
import {onboardingActivationCommandSchema} from "./onboarding-activation";
import {onboardingPolicySchema} from "./onboarding-policy";
import {OnboardingConfigurationError} from "./onboarding-wizard";

export const onboardingActivationRequested="onboarding.activation_requested";
export const onboardingActivationSourceSchema=z.object({source:z.literal("CORE_ONBOARDING_VALIDATED_ACTIVATION"),reviewRevisionId:onboardingIdSchema,reviewSourceFingerprint:onboardingFingerprintSchema,reviewPayloadSha256:onboardingFingerprintSchema}).strict();
export const onboardingActivationPayloadBindingSchema=onboardingPayloadBindingSchema.omit({revisionId:true}).extend({activationId:onboardingIdSchema,reviewRevisionId:onboardingIdSchema,propertyId:onboardingIdSchema,sourceFingerprint:onboardingFingerprintSchema,authorizationFingerprint:onboardingFingerprintSchema,requestedAt:z.iso.datetime()}).strict();
export type OnboardingActivationPayloadBinding=z.infer<typeof onboardingActivationPayloadBindingSchema>;
const payloadSchema=z.object({command:onboardingActivationCommandSchema,source:onboardingActivationSourceSchema,policySnapshot:z.object({id:onboardingIdSchema,version:z.number().int().positive(),value:onboardingPolicySchema}).strict(),authorizationCap:authorizationCapSchema}).strict();
export type OnboardingActivationPayload=z.infer<typeof payloadSchema>;
function context(raw:OnboardingActivationPayloadBinding){const b=onboardingActivationPayloadBindingSchema.parse(raw);return JSON.stringify(["alvillas-private-background-property-activation-v1",b.organizationId,b.sessionId,b.activationId,b.reviewRevisionId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.policyId,b.policyVersion,b.sourceFingerprint,b.authorizationFingerprint,b.requestedAt]);}
function bound(raw:unknown,binding:OnboardingActivationPayloadBinding){
 const value=payloadSchema.parse(raw),b=onboardingActivationPayloadBindingSchema.parse(binding),{command,source,policySnapshot,authorizationCap}=value;
 if(command.sessionId!==b.sessionId||command.previousRevisionId!==b.reviewRevisionId||command.target.propertyId!==b.propertyId||command.idempotencyKey!==b.commandKey||source.reviewRevisionId!==b.reviewRevisionId||jsonbFingerprint(source)!==b.sourceFingerprint||policySnapshot.id!==b.policyId||policySnapshot.version!==b.policyVersion||!policySnapshot.value.activation?.modes.includes("BACKGROUND")||authorizationCap.organizationId!==b.organizationId||authorizationCap.userAccountId!==b.createdBy||jsonbFingerprint(authorizationCap)!==b.authorizationFingerprint)throw new OnboardingConfigurationError();
 return value;
}
export function encryptOnboardingActivationPayload(raw:OnboardingActivationPayload,binding:OnboardingActivationPayloadBinding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const value:unknown=JSON.parse(JSON.stringify(raw)),bytes=Buffer.from(JSON.stringify(bound(value,binding)),"utf8");try{if(bytes.byteLength>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(bytes,context(binding),env);if(cipher.byteLength>onboardingMaximumConfigurationRecordBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{bytes.fill(0);}}
export function decryptOnboardingActivationPayload(cipher:Uint8Array,binding:OnboardingActivationPayloadBinding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();const bytes=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(bytes.toString("utf8")),binding);}finally{bytes.fill(0);}}
