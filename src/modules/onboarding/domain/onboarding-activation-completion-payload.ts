import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {authorizationCapSchema} from "@/platform/authz/authorization-cap";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {onboardingMaximumRequestBytes} from "@/platform/onboarding/limits";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingIdSchema as id,onboardingFingerprintSchema as fingerprint} from "./onboarding-primitives";
import {onboardingActivationCommandSchema} from "./onboarding-activation";
import {onboardingActivationEffects,onboardingActivationEffectSchema} from "./onboarding-activation-policy";
import {onboardingActivationEffectEvidenceSchema} from "./onboarding-activation-effect-evidence";
import {onboardingPolicySchema} from "./onboarding-policy";
import {OnboardingConfigurationError} from "./onboarding-wizard";

const property=z.object({id,xmin:z.string().regex(/^\d+$/u),tuple:z.string().regex(/^\(\d+,\d+\)$/u),status:z.enum(["DRAFT","ONBOARDING","ACTIVE"])}).strict();
const head=z.object({eventId:id,effectKind:onboardingActivationEffectSchema,resultFingerprint:fingerprint}).strict();
export const onboardingActivationCompletionSourceSchema=z.object({source:z.literal("CORE_ONBOARDING_PROVEN_ACTIVATION"),activationId:id,reviewRevisionId:id,reviewSourceFingerprint:fingerprint,requestPayloadSha256:fingerprint,beforeProperty:property,afterProperty:property,effects:z.array(head).length(5)}).strict().superRefine((value,context)=>{
 if(!["DRAFT","ONBOARDING"].includes(value.beforeProperty.status)||value.afterProperty.status!=="ACTIVE"||value.beforeProperty.id!==value.afterProperty.id||value.beforeProperty.tuple===value.afterProperty.tuple||new Set(value.effects.map(effect=>effect.effectKind)).size!==onboardingActivationEffects.length)context.addIssue({code:"custom",message:"actual_distinct_native_activation_sources_required"});
});
export const onboardingActivationCompletionBindingSchema=onboardingPayloadBindingSchema.extend({propertyId:id,previousRevisionId:id,activationId:id,requestCommandKey:id,sourceFingerprint:fingerprint,reviewFingerprint:fingerprint,authorizationFingerprint:fingerprint,activatedAt:z.iso.datetime()}).strict();
type Binding=z.infer<typeof onboardingActivationCompletionBindingSchema>;
const payload=z.object({command:onboardingActivationCommandSchema,source:onboardingActivationCompletionSourceSchema,effects:z.array(onboardingActivationEffectEvidenceSchema).length(5),policySnapshot:z.object({id,version:z.number().int().positive(),value:onboardingPolicySchema}).strict(),authorizationCap:authorizationCapSchema,currentConfiguration:z.object({metadataFingerprint:fingerprint,recordedFingerprint:fingerprint}).strict().optional()}).strict();
export type OnboardingActivationCompletionPayload=z.infer<typeof payload>;
const maximumBytes=onboardingMaximumRequestBytes*3;
function context(raw:Binding){const b=onboardingActivationCompletionBindingSchema.parse(raw);return JSON.stringify(["alvillas-private-operational-activation-completion-v1",b.organizationId,b.sessionId,b.revisionId,b.previousRevisionId,b.activationId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.requestCommandKey,b.policyId,b.policyVersion,b.sourceFingerprint,b.reviewFingerprint,b.authorizationFingerprint,b.activatedAt]);}
function bound(raw:unknown,rawBinding:Binding){
 const value=payload.parse(raw),b=onboardingActivationCompletionBindingSchema.parse(rawBinding),{command,source,policySnapshot,authorizationCap}=value;
 if(command.sessionId!==b.sessionId||command.previousRevisionId!==b.previousRevisionId||command.target.propertyId!==b.propertyId||command.idempotencyKey!==b.requestCommandKey||command.reviewFingerprint!==b.reviewFingerprint||source.activationId!==b.activationId||source.reviewRevisionId!==b.previousRevisionId||source.beforeProperty.id!==b.propertyId||jsonbFingerprint(source)!==b.sourceFingerprint||policySnapshot.id!==b.policyId||policySnapshot.version!==b.policyVersion||!policySnapshot.value.activation||authorizationCap.organizationId!==b.organizationId||authorizationCap.userAccountId!==b.createdBy)throw new OnboardingConfigurationError();
 if(new Set(value.effects.map(effect=>effect.effectKind)).size!==onboardingActivationEffects.length)throw new OnboardingConfigurationError();
 if(jsonbFingerprint(authorizationCap)!==b.authorizationFingerprint)throw new OnboardingConfigurationError();
 for(const effect of value.effects){const recorded=source.effects.find(item=>item.effectKind===effect.effectKind);if(effect.activationId!==b.activationId||!recorded||recorded.resultFingerprint!==jsonbFingerprint(effect))throw new OnboardingConfigurationError();}
 return value;
}
export function encryptOnboardingActivationCompletion(raw:OnboardingActivationCompletionPayload,binding:Binding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const normalized:unknown=JSON.parse(JSON.stringify(raw)),bytes=Buffer.from(JSON.stringify(bound(normalized,binding)),"utf8");try{if(bytes.byteLength>maximumBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(bytes,context(binding),env);if(cipher.byteLength>maximumBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{bytes.fill(0);}}
export function decryptOnboardingActivationCompletion(cipher:Uint8Array,binding:Binding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>maximumBytes)throw new OnboardingConfigurationError();const bytes=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(bytes.toString("utf8")),binding);}finally{bytes.fill(0);}}
export function assertCompletionOriginal(value:OnboardingActivationCompletionPayload,expected:{command:unknown;policySnapshot:unknown;authorizationCap:unknown}){if(!isDeepStrictEqual(value.command,expected.command)||!isDeepStrictEqual(value.policySnapshot,expected.policySnapshot)||!isDeepStrictEqual(value.authorizationCap,expected.authorizationCap))throw new OnboardingConfigurationError();}
