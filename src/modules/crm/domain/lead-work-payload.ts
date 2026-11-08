import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requireLeadPayloadKeys} from "./lead-payload";
import {canonicalLeadWorkCommand,leadWorkKindSchema,type LeadWorkCommand} from "./lead-work";

const uuid=z.uuid().transform(value=>value.toLowerCase());
const bindingSchema=z.object({organizationId:uuid,leadId:uuid,revisionId:uuid,previousRevisionId:uuid.nullable(),subjectId:uuid,previousSubjectRevisionId:uuid.nullable(),kind:leadWorkKindSchema,createdBy:uuid,
  policyId:uuid,policyVersion:z.number().int().positive(),capturePolicyId:uuid,capturePolicyVersion:z.number().int().positive(),commandKey:uuid}).strict();
export type LeadWorkPayloadBinding=z.infer<typeof bindingSchema>;
const context=(raw:LeadWorkPayloadBinding)=>{const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-lead-work-v1",b.organizationId,b.leadId,b.revisionId,b.previousRevisionId,b.subjectId,b.previousSubjectRevisionId,b.kind,b.createdBy,b.policyId,b.policyVersion,b.capturePolicyId,b.capturePolicyVersion,b.commandKey]);};
function bound(raw:unknown,binding:LeadWorkPayloadBinding){
  const value=canonicalLeadWorkCommand(raw),b=bindingSchema.parse(binding);
  if(value.leadId!==b.leadId||value.previousRevisionId!==b.previousRevisionId||value.previousSubjectRevisionId!==b.previousSubjectRevisionId||value.kind!==b.kind||value.idempotencyKey!==b.commandKey||
    (value.subjectId===null?b.subjectId!==b.revisionId:value.subjectId!==b.subjectId))throw new Error("lead_work_payload_binding");
  return value;
}
export function encryptLeadWorkPayload(raw:LeadWorkCommand,binding:LeadWorkPayloadBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,true);const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{return encryptBytes(plain,context(binding),env);}finally{plain.fill(0);}
}
export function decryptLeadWorkPayload(cipher:Uint8Array,binding:LeadWorkPayloadBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,false);const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
