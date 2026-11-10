import {z} from "zod";
import {isDeepStrictEqual} from "node:util";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {onboardingPayloadBindingSchema} from "./onboarding-payload";
import {onboardingOwnerSchema,OnboardingConfigurationError,onboardingMaximumRequestBytes} from "./onboarding-wizard";
import {onboardingPropertySnapshotSchema} from "./onboarding-property";
import {canonicalOnboardingTeamCommand,onboardingTeamSnapshotSchema,type OnboardingTeamCommand} from "./onboarding-team";

const bindingSchema=onboardingPayloadBindingSchema.extend({propertyId:z.uuid().transform(value=>value.toLowerCase())}).strict();
export type OnboardingTeamPayloadBinding=z.infer<typeof bindingSchema>;
export const onboardingMaximumTeamPayloadBytes=onboardingMaximumRequestBytes*3;
const payloadSchema=z.object({command:z.unknown(),originalOwner:onboardingOwnerSchema,originalProperty:onboardingPropertySnapshotSchema,previousTeam:onboardingTeamSnapshotSchema,originalTeam:onboardingTeamSnapshotSchema}).strict();
type PayloadInput=Omit<z.infer<typeof payloadSchema>,"command">&{command:OnboardingTeamCommand};
function context(raw:OnboardingTeamPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-property-onboarding-team-v1",b.organizationId,b.sessionId,b.revisionId,b.ownerId,b.propertyId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:OnboardingTeamPayloadBinding){
 const value=payloadSchema.parse(raw),command=canonicalOnboardingTeamCommand(value.command),b=bindingSchema.parse(binding),original=value.originalTeam,previous=value.previousTeam,target=command.target;
 if(command.sessionId!==b.sessionId||command.idempotencyKey!==b.commandKey||command.target.propertyId!==b.propertyId||value.originalProperty.id!==b.propertyId||!["DRAFT","ONBOARDING"].includes(value.originalProperty.status)||original.propertyId!==b.propertyId||previous.propertyId!==b.propertyId)throw new OnboardingConfigurationError();
 if(target.mode==="LINK"){
  if(commandFingerprint(previous)!==commandFingerprint(original)||original.assignments.length!==target.assignmentIds.length||original.assignments.some(row=>!target.assignmentIds.includes(row.id)))throw new OnboardingConfigurationError();
 }else{
  if(previous.assignments.length!==0||original.assignments.length!==target.assignments.length)throw new OnboardingConfigurationError();
  const remaining=[...original.assignments];for(const input of target.assignments){const index=remaining.findIndex(row=>row.personId===input.personId&&row.roleId===input.roleId&&row.userAccountId===input.userAccountId&&row.validFrom===input.validFrom&&row.validTo===input.validTo&&isDeepStrictEqual(row.conditions,input.assignedToMe?{assignedToMe:true}:null)&&row.createdBy===b.createdBy&&row.archivedAt===null);if(index<0)throw new OnboardingConfigurationError();remaining.splice(index,1);}
 }
 return{command,originalOwner:value.originalOwner,originalProperty:value.originalProperty,previousTeam:previous,originalTeam:original};
}
export function encryptOnboardingTeamPayload(raw:PayloadInput,binding:OnboardingTeamPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,true,()=>new OnboardingConfigurationError());const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{if(plain.byteLength>onboardingMaximumTeamPayloadBytes)throw new OnboardingConfigurationError();const cipher=encryptBytes(plain,context(binding),env);if(cipher.byteLength>onboardingMaximumTeamPayloadBytes){cipher.fill(0);throw new OnboardingConfigurationError();}return cipher;}finally{plain.fill(0);}
}
export function decryptOnboardingTeamPayload(cipher:Uint8Array,binding:OnboardingTeamPayloadBinding,env:NodeJS.ProcessEnv=process.env){
 requirePrivatePayloadKeys(env,false,()=>new OnboardingConfigurationError());if(cipher.byteLength>onboardingMaximumTeamPayloadBytes)throw new OnboardingConfigurationError();const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
