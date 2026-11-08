import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { leadCaptureInputSchema, LeadConfigurationError, type LeadCaptureInput } from "./lead-capture";

const bindingSchema = z.object({
  organizationId:z.uuid(), leadId:z.uuid(), createdBy:z.uuid(), policyId:z.uuid(), policyVersion:z.number().int().positive(),
  channel:leadCaptureInputSchema.shape.channel, sourceKey:leadCaptureInputSchema.shape.sourceKey,
  idempotencyKey:z.uuid()
}).strict();
export type LeadPayloadBinding = z.infer<typeof bindingSchema>;

function context(input:LeadPayloadBinding):string {
  const value=bindingSchema.parse(input);
  return JSON.stringify(["alvillas-private-lead-capture-v1",value.organizationId,value.leadId,value.createdBy,
    value.policyId,value.policyVersion,value.channel,value.sourceKey,value.idempotencyKey]);
}
function requireKeys(env:NodeJS.ProcessEnv){
  const entries=env.ENCRYPTION_KEYS?.split(",").map(entry=>entry.trim()).filter(Boolean)??[],versions=new Set<string>();
  if(!entries.length)throw new LeadConfigurationError();
  for(const entry of entries){
    const match=/^([a-zA-Z0-9_.-]{1,120}):([a-zA-Z0-9+/]+={0,2})$/u.exec(entry);
    if(!match||versions.has(match[1]))throw new LeadConfigurationError();
    const decoded=Buffer.from(match[2],"base64");
    try{if(decoded.length!==32||decoded.toString("base64")!==match[2])throw new LeadConfigurationError();}finally{decoded.fill(0);}
    versions.add(match[1]);
  }
}
function boundPayload(input:unknown,binding:LeadPayloadBinding):LeadCaptureInput {
  const value=leadCaptureInputSchema.parse(input);
  if(value.channel!==binding.channel||value.sourceKey!==binding.sourceKey||value.idempotencyKey!==binding.idempotencyKey)
    throw new LeadConfigurationError();
  return value;
}

/** Reuse the platform AEAD and retained key ring; identity fallback keys cannot encrypt lead PII. */
export function encryptLeadPayload(input:LeadCaptureInput,binding:LeadPayloadBinding,env:NodeJS.ProcessEnv=process.env):Buffer {
  requireKeys(env);
  return encryptBytes(Buffer.from(JSON.stringify(boundPayload(input,binding)),"utf8"),context(binding),env);
}
export function decryptLeadPayload(ciphertext:Uint8Array,binding:LeadPayloadBinding,env:NodeJS.ProcessEnv=process.env):LeadCaptureInput {
  requireKeys(env);
  const plain=decryptBytes(ciphertext,context(binding),env);
  try{return boundPayload(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
