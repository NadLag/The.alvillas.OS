import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { requirePrivatePayloadKeys } from "@/platform/auth/private-payload-keys";
import { leadCaptureInputSchema, LeadConfigurationError, type LeadCaptureInput } from "./lead-capture";

const uuid=z.uuid().transform(value=>value.toLowerCase());
const bindingSchema = z.object({
  organizationId:uuid, leadId:uuid, createdBy:uuid, policyId:uuid, policyVersion:z.number().int().positive(),
  channel:leadCaptureInputSchema.shape.channel, sourceKey:leadCaptureInputSchema.shape.sourceKey,
  idempotencyKey:uuid
}).strict();
export type LeadPayloadBinding = z.infer<typeof bindingSchema>;

function context(input:LeadPayloadBinding):string {
  const value=bindingSchema.parse(input);
  return JSON.stringify(["alvillas-private-lead-capture-v1",value.organizationId,value.leadId,value.createdBy,
    value.policyId,value.policyVersion,value.channel,value.sourceKey,value.idempotencyKey]);
}
export function requireLeadPayloadKeys(env:NodeJS.ProcessEnv,encrypting:boolean){
  return requirePrivatePayloadKeys(env,encrypting,()=>new LeadConfigurationError());
}
function boundPayload(input:unknown,binding:LeadPayloadBinding):LeadCaptureInput {
  const value=leadCaptureInputSchema.parse(input),identity=bindingSchema.parse(binding);
  if(value.channel!==identity.channel||value.sourceKey!==identity.sourceKey||value.idempotencyKey!==identity.idempotencyKey)
    throw new LeadConfigurationError();
  return value;
}

/** Reuse the platform AEAD and retained key ring; identity fallback keys cannot encrypt lead PII. */
export function encryptLeadPayload(input:LeadCaptureInput,binding:LeadPayloadBinding,env:NodeJS.ProcessEnv=process.env):Buffer {
  requireLeadPayloadKeys(env,true);
  return encryptBytes(Buffer.from(JSON.stringify(boundPayload(input,binding)),"utf8"),context(binding),env);
}
export function decryptLeadPayload(ciphertext:Uint8Array,binding:LeadPayloadBinding,env:NodeJS.ProcessEnv=process.env):LeadCaptureInput {
  requireLeadPayloadKeys(env,false);
  const plain=decryptBytes(ciphertext,context(binding),env);
  try{return boundPayload(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
