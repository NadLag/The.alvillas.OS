import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requireLeadPayloadKeys} from "./lead-payload";
import {leadStageReasonSchema} from "./lead-pipeline";

const uuid=z.uuid().transform(value=>value.toLowerCase());
const bindingSchema=z.object({organizationId:uuid,leadId:uuid,revisionId:uuid,createdBy:uuid,commandKey:uuid}).strict();
export type LeadStageReasonBinding=z.infer<typeof bindingSchema>;
const context=(binding:LeadStageReasonBinding)=>{const value=bindingSchema.parse(binding);return JSON.stringify(["alvillas-private-lead-stage-reason-v1",value.organizationId,value.leadId,value.revisionId,value.createdBy,value.commandKey]);};
export function encryptLeadStageReason(raw:unknown,binding:LeadStageReasonBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,true);const plain=Buffer.from(leadStageReasonSchema.parse(raw),"utf8");try{return encryptBytes(plain,context(binding),env);}finally{plain.fill(0);}
}
export function decryptLeadStageReason(cipher:Uint8Array,binding:LeadStageReasonBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,false);const plain=decryptBytes(cipher,context(binding),env);try{return leadStageReasonSchema.parse(plain.toString("utf8"));}finally{plain.fill(0);}
}
