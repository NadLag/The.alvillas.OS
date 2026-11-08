import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
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
  const entries=env.ENCRYPTION_KEYS?.split(",").map(entry=>entry.trim()).filter(Boolean)??[],versions=new Set<string>();
  if(!entries.length)throw new LeadConfigurationError();
  for(const [index,entry] of entries.entries()){
    const boundary=entry.indexOf(":"),version=boundary<0?"v1":entry.slice(0,boundary),material=boundary<0?entry:entry.slice(boundary+1);
    if(!version||!material||versions.has(version))throw new LeadConfigurationError();
    if(encrypting&&index===0){
      if(!/^[a-zA-Z0-9_.-]{1,120}$/u.test(version)||!/^[a-zA-Z0-9+/]+={0,2}$/u.test(material))throw new LeadConfigurationError();
      const decoded=Buffer.from(material,"base64");
      try{if(decoded.length!==32||decoded.toString("base64")!==material)throw new LeadConfigurationError();}finally{decoded.fill(0);}
    }
    versions.add(version);
  }
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
