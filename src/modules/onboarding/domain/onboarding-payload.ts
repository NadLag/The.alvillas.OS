import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {canonicalOnboardingCommand,onboardingOwnerSchema,OnboardingConfigurationError,type OnboardingCommand} from "./onboarding-wizard";

const uuid=z.uuid().transform(value=>value.toLowerCase());
const bindingSchema=z.object({organizationId:uuid,sessionId:uuid,revisionId:uuid,ownerId:uuid,createdBy:uuid,commandKey:uuid,policyId:uuid,policyVersion:z.number().int().positive()}).strict();
export {bindingSchema as onboardingPayloadBindingSchema};
export type OnboardingPayloadBinding=z.infer<typeof bindingSchema>;
const payloadSchema=z.object({command:z.unknown(),originalOwner:onboardingOwnerSchema}).strict();
function context(raw:OnboardingPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-property-onboarding-v1",b.organizationId,b.sessionId,b.revisionId,b.ownerId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:OnboardingPayloadBinding){const value=payloadSchema.parse(raw),command=canonicalOnboardingCommand(value.command),b=bindingSchema.parse(binding);if(command.sessionId!==null&&command.sessionId!==b.sessionId||command.idempotencyKey!==b.commandKey||command.target.mode==="LINK"&&command.target.ownerId!==b.ownerId)throw new OnboardingConfigurationError();return{command,originalOwner:value.originalOwner};}
export function encryptOnboardingPayload(raw:{command:OnboardingCommand;originalOwner:z.infer<typeof onboardingOwnerSchema>},binding:OnboardingPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{return encryptBytes(plain,context(binding),env);}finally{plain.fill(0);}
}
export function decryptOnboardingPayload(cipher:Uint8Array,binding:OnboardingPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
