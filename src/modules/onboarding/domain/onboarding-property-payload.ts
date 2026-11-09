import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {parseConfiguredOnboardingPropertyProfile} from "@/platform/onboarding/contracts";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingOwnerSchema,OnboardingConfigurationError} from "./onboarding-wizard";
import {canonicalOnboardingPropertyCommand,onboardingPropertySnapshotSchema,type OnboardingPropertyCommand,type OnboardingPropertySnapshot} from "./onboarding-property";

const bindingSchema=onboardingPayloadBindingSchema.extend({propertyId:z.uuid().transform(value=>value.toLowerCase())}).strict();
export type OnboardingPropertyPayloadBinding=z.infer<typeof bindingSchema>;
const payloadSchema=z.object({command:z.unknown(),originalOwner:onboardingOwnerSchema,originalProperty:onboardingPropertySnapshotSchema,initialOperatingProfile:z.unknown()}).strict();
type PayloadInput={command:OnboardingPropertyCommand;originalOwner:z.infer<typeof onboardingOwnerSchema>;originalProperty:OnboardingPropertySnapshot;initialOperatingProfile:unknown};
function context(raw:OnboardingPropertyPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-property-onboarding-property-v1",b.organizationId,b.sessionId,b.revisionId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:OnboardingPropertyPayloadBinding){
 const value=payloadSchema.parse(raw),command=canonicalOnboardingPropertyCommand(value.command),b=bindingSchema.parse(binding);
 if(command.sessionId!==b.sessionId||command.idempotencyKey!==b.commandKey||value.originalProperty.id!==b.propertyId||!["DRAFT","ONBOARDING"].includes(value.originalProperty.status))throw new OnboardingConfigurationError();
 if(command.target.mode==="LINK"){
  if(command.target.propertyId!==b.propertyId||value.initialOperatingProfile!==null)throw new OnboardingConfigurationError();
  return{command,originalOwner:value.originalOwner,originalProperty:value.originalProperty,initialOperatingProfile:null};
 }
 if(command.target.input.ownerId!==b.ownerId||value.originalProperty.status!=="DRAFT")throw new OnboardingConfigurationError();
 return{command,originalOwner:value.originalOwner,originalProperty:value.originalProperty,initialOperatingProfile:parseConfiguredOnboardingPropertyProfile(value.initialOperatingProfile)};
}
export function encryptOnboardingPropertyPayload(raw:PayloadInput,binding:OnboardingPropertyPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{return encryptBytes(plain,context(binding),env);}finally{plain.fill(0);}
}
export function decryptOnboardingPropertyPayload(cipher:Uint8Array,binding:OnboardingPropertyPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
