import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {guestHubCapabilityBindingSchema,guestHubFingerprintSchema,guestHubIdSchema,guestHubTokenTextSchema} from "./guest-hub-contract";
import {guestHubCapabilityDigest,verifyGuestHubCapability} from "./guest-hub-capability";
import {GuestHubConfigurationError} from "./guest-hub-policy";

export const guestHubPayloadBindingSchema=guestHubCapabilityBindingSchema.safeExtend({
 createdBy:guestHubIdSchema,policyId:guestHubIdSchema,policyVersion:z.number().int().positive(),
 commandKey:guestHubIdSchema,commandHash:guestHubFingerprintSchema,
 policyFingerprint:guestHubFingerprintSchema,sourceFingerprint:guestHubFingerprintSchema,tokenHash:guestHubFingerprintSchema
});
export type GuestHubPayloadBinding=z.infer<typeof guestHubPayloadBindingSchema>;
const payloadSchema=z.object({schemaVersion:z.literal(1),token:guestHubTokenTextSchema}).strict();
export type GuestHubPrivatePayload=z.infer<typeof payloadSchema>;

function context(value:GuestHubPayloadBinding):string{
 return JSON.stringify(["alvillas-private-guest-hub-link-v1",value.organizationId,value.linkId,value.reservationId,value.propertyId,value.guestId,
  value.issuedAt,value.expiresAt,value.createdBy,value.policyId,value.policyVersion,value.commandKey,value.commandHash,
  value.policyFingerprint,value.sourceFingerprint,value.tokenHash]);
}
function boundPayload(raw:unknown,binding:GuestHubPayloadBinding,env:NodeJS.ProcessEnv):GuestHubPrivatePayload{
 const payload=payloadSchema.parse(raw),claims=verifyGuestHubCapability(payload.token,env);
 for(const key of["organizationId","linkId","reservationId","propertyId","guestId","issuedAt","expiresAt"]as const)
  if(claims[key]!==binding[key])throw new GuestHubConfigurationError();
 if(guestHubCapabilityDigest(payload.token)!==binding.tokenHash)throw new GuestHubConfigurationError();
 return payload;
}

/** Persist only the original signed capability, encrypted with its complete immutable native identity. */
export function encryptGuestHubPayload(raw:unknown,rawBinding:GuestHubPayloadBinding,env:NodeJS.ProcessEnv=process.env):Buffer{
 let plain:Buffer|undefined;
 try{
  requirePrivatePayloadKeys(env,true,()=>new GuestHubConfigurationError());
  const binding=guestHubPayloadBindingSchema.parse(rawBinding),payload=boundPayload(raw,binding,env);
  plain=Buffer.from(JSON.stringify(payload),"utf8");return encryptBytes(plain,context(binding),env);
 }catch{throw new GuestHubConfigurationError();}finally{plain?.fill(0);}
}

/** Recovery authenticates stored bytes and the original token; it never creates a replacement capability. */
export function decryptGuestHubPayload(ciphertext:Uint8Array,rawBinding:GuestHubPayloadBinding,env:NodeJS.ProcessEnv=process.env):GuestHubPrivatePayload{
 let plain:Buffer|undefined;
 try{
  requirePrivatePayloadKeys(env,false,()=>new GuestHubConfigurationError());
  const binding=guestHubPayloadBindingSchema.parse(rawBinding);plain=decryptBytes(ciphertext,context(binding),env);
  return boundPayload(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(plain)),binding,env);
 }catch{throw new GuestHubConfigurationError();}finally{plain?.fill(0);}
}
