import {onboardingConfigurationReferenceCaptureSchema,onboardingReferenceFact} from "./onboarding-configuration-references";
import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {onboardingMaximumConfigurationRecordBytes} from "@/platform/onboarding/limits";
import {projectOnboardingInventorySettings,projectOnboardingServicesSettings,onboardingInventoryTemplateValuesSchema,onboardingServicesTemplateValuesSchema} from "@/platform/onboarding/contracts";
import {projectOnboardingWorkflowsSettings,onboardingWorkflowsTemplateValuesSchema} from "@/platform/onboarding/workflows-contracts";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-contract";
import {onboardingConfigurationCommandSchema} from "./onboarding-configuration-review";
import {onboardingConfigurationValidationSchema,validateOnboardingConfiguration} from "./onboarding-configuration";
import {onboardingPolicySchema} from "./onboarding-policy";
import {OnboardingConfigurationError} from "./onboarding-wizard";
import {nativeOperatingRuleProjection} from "./onboarding-operating-profile";

export const onboardingConfigurationPayloadBindingSchema=onboardingPayloadBindingSchema.extend({propertyId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,sourceFingerprint:onboardingFingerprintSchema,validatedAt:z.iso.datetime()}).strict();
export type OnboardingConfigurationPayloadBinding=z.infer<typeof onboardingConfigurationPayloadBindingSchema>;
const catalogSources=z.object({ruleValue:z.json().nullable(),templates:z.array(z.object({id:onboardingIdSchema,values:z.json()}).strict()).max(1)}).strict();
export const onboardingConfigurationOriginalSourcesSchema=z.object({inventory:catalogSources,services:catalogSources,workflows:z.object({ruleValues:z.json(),templates:z.array(z.object({id:onboardingIdSchema,values:z.json()}).strict()).max(1)}).strict(),operatingRule:z.json().nullable(),workflowReferences:z.array(onboardingConfigurationReferenceCaptureSchema)}).strict();
const payloadSchema=z.object({command:onboardingConfigurationCommandSchema,validation:onboardingConfigurationValidationSchema,policySnapshot:z.object({id:onboardingIdSchema,version:z.number().int().positive(),value:onboardingPolicySchema}).strict(),originalSources:onboardingConfigurationOriginalSourcesSchema}).strict();
export type OnboardingConfigurationPayload=z.infer<typeof payloadSchema>;
function context(raw:OnboardingConfigurationPayloadBinding){const b=onboardingConfigurationPayloadBindingSchema.parse(raw);return JSON.stringify(["alvillas-private-whole-property-configuration-review-v1",b.organizationId,b.sessionId,b.revisionId,b.previousRevisionId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.policyId,b.policyVersion,b.sourceFingerprint,b.validatedAt]);}
function bound(raw:unknown,binding:OnboardingConfigurationPayloadBinding){
 const value=payloadSchema.parse(raw),b=onboardingConfigurationPayloadBindingSchema.parse(binding),{command,validation,policySnapshot,originalSources}=value,facts=validation.facts;
 if(command.sessionId!==b.sessionId||command.previousRevisionId!==b.previousRevisionId||command.target.propertyId!==b.propertyId||command.idempotencyKey!==b.commandKey||facts.sessionId!==b.sessionId||facts.ownerId!==b.ownerId||facts.propertyId!==b.propertyId||policySnapshot.id!==b.policyId||policySnapshot.version!==b.policyVersion||!validation.ready||!isDeepStrictEqual(validation,validateOnboardingConfiguration(facts,policySnapshot.value,new Date(b.validatedAt))))throw new OnboardingConfigurationError();
 if(!isDeepStrictEqual(facts.inventory?.settings,originalSources.inventory.ruleValue===null?null:projectOnboardingInventorySettings(originalSources.inventory.ruleValue))||!isDeepStrictEqual(facts.services?.settings,originalSources.services.ruleValue===null?null:projectOnboardingServicesSettings(originalSources.services.ruleValue))||!isDeepStrictEqual(facts.workflows?.settings,projectOnboardingWorkflowsSettings(originalSources.workflows.ruleValues)))throw new OnboardingConfigurationError();
 if(!isDeepStrictEqual(facts.operatingRule,nativeOperatingRuleProjection(facts.operatingRule?{...facts.operatingRule,value:originalSources.operatingRule}:null))||!facts.operatingRule&&originalSources.operatingRule!==null)throw new OnboardingConfigurationError();
 for(const row of originalSources.inventory.templates)onboardingInventoryTemplateValuesSchema.parse(row.values);for(const row of originalSources.services.templates)onboardingServicesTemplateValuesSchema.parse(row.values);for(const row of originalSources.workflows.templates)onboardingWorkflowsTemplateValuesSchema.parse(row.values);
 if(originalSources.workflowReferences.length!==facts.workflowReferences.length||new Set(originalSources.workflowReferences.map(row=>row.key)).size!==originalSources.workflowReferences.length)throw new OnboardingConfigurationError();for(const row of originalSources.workflowReferences)if(!isDeepStrictEqual(onboardingReferenceFact(row.key,row,row.value),facts.workflowReferences.find(fact=>fact.key===row.key)))throw new OnboardingConfigurationError();
 for(const family of["inventory","services","workflows"]as const){const expected=facts[family]?.template?.id,templates=originalSources[family].templates;if(expected?(templates.length!==1||templates[0].id!==expected):templates.length!==0)throw new OnboardingConfigurationError();}
 return value;
}
export function encryptOnboardingConfigurationPayload(raw:OnboardingConfigurationPayload,binding:OnboardingConfigurationPayloadBinding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const value:unknown=JSON.parse(JSON.stringify(raw)),bytes=Buffer.from(JSON.stringify(bound(value,binding)),"utf8");try{if(bytes.byteLength>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(bytes,context(binding),env);if(cipher.byteLength>onboardingMaximumConfigurationRecordBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{bytes.fill(0);}}
export function decryptOnboardingConfigurationPayload(cipher:Uint8Array,binding:OnboardingConfigurationPayloadBinding,env:NodeJS.ProcessEnv=process.env){requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();const bytes=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(bytes.toString("utf8")),binding);}finally{bytes.fill(0);}}
