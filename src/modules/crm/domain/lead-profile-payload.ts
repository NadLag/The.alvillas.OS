import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requireLeadPayloadKeys} from "./lead-payload";
import {canonicalLeadProfileCommand,type LeadProfileCommand} from "./lead-profile";

const uuid=z.uuid().transform(value=>value.toLowerCase());
const bindingSchema=z.object({organizationId:uuid,leadId:uuid,revisionId:uuid,previousRevisionId:uuid.nullable(),createdBy:uuid,
  policyId:uuid,policyVersion:z.number().int().positive(),capturePolicyId:uuid,capturePolicyVersion:z.number().int().positive(),commandKey:uuid}).strict();
export type LeadProfilePayloadBinding=z.infer<typeof bindingSchema>;
const context=(raw:LeadProfilePayloadBinding)=>{const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-lead-profile-v1",b.organizationId,b.leadId,b.revisionId,b.previousRevisionId,b.createdBy,b.policyId,b.policyVersion,b.capturePolicyId,b.capturePolicyVersion,b.commandKey]);};
function bound(raw:unknown,binding:LeadProfilePayloadBinding){
  const value=canonicalLeadProfileCommand(raw),b=bindingSchema.parse(binding);
  if(value.leadId!==b.leadId||value.previousRevisionId!==b.previousRevisionId||value.idempotencyKey!==b.commandKey)throw new Error("lead_profile_payload_binding");return value;
}
export function encryptLeadProfilePayload(raw:LeadProfileCommand,binding:LeadProfilePayloadBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,true);const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{return encryptBytes(plain,context(binding),env);}finally{plain.fill(0);}
}
export function decryptLeadProfilePayload(cipher:Uint8Array,binding:LeadProfilePayloadBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,false);const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
