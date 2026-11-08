import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requireLeadPayloadKeys} from "./lead-payload";
import {canonicalLeadConversionCommand,leadConversionOwnerSchema,type LeadConversionCommand} from "./lead-conversion";

const uuid=z.uuid().transform(value=>value.toLowerCase());
const bindingSchema=z.object({organizationId:uuid,leadId:uuid,conversionId:uuid,ownerId:uuid,createdBy:uuid,commandKey:uuid,policyId:uuid,policyVersion:z.number().int().positive()}).strict();
export type LeadConversionPayloadBinding=z.infer<typeof bindingSchema>;
const projectionSchema=leadConversionOwnerSchema;
const payloadSchema=z.object({command:z.unknown(),originalOwner:projectionSchema}).strict();
function context(raw:LeadConversionPayloadBinding){const b=bindingSchema.parse(raw);return JSON.stringify(["alvillas-private-lead-conversion-v1",b.organizationId,b.leadId,b.conversionId,b.ownerId,b.createdBy,b.commandKey,b.policyId,b.policyVersion]);}
function bound(raw:unknown,binding:LeadConversionPayloadBinding){const value=payloadSchema.parse(raw),command=canonicalLeadConversionCommand(value.command),b=bindingSchema.parse(binding);if(command.leadId!==b.leadId||command.idempotencyKey!==b.commandKey||command.target.mode==="LINK"&&command.target.ownerId!==b.ownerId)throw new Error("lead_conversion_payload_binding");return{command,originalOwner:value.originalOwner};}
export function encryptLeadConversionPayload(raw:{command:LeadConversionCommand;originalOwner:z.infer<typeof projectionSchema>},binding:LeadConversionPayloadBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,true);const plain=Buffer.from(JSON.stringify(bound(raw,binding)),"utf8");try{return encryptBytes(plain,context(binding),env);}finally{plain.fill(0);}
}
export function decryptLeadConversionPayload(cipher:Uint8Array,binding:LeadConversionPayloadBinding,env:NodeJS.ProcessEnv=process.env){
  requireLeadPayloadKeys(env,false);const plain=decryptBytes(cipher,context(binding),env);try{return bound(JSON.parse(plain.toString("utf8")),binding);}finally{plain.fill(0);}
}
