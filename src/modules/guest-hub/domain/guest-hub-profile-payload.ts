import {z} from "zod";
import {encryptBytes,decryptBytes} from "@/platform/auth/secret-encryption";
import {requirePrivatePayloadKeys} from "@/platform/auth/private-payload-keys";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {guestHubProfileReviewBindingSchema,guestHubProfileReviewTokenSchema} from "./guest-hub-profile-contract";
import {guestHubProfileValuesSchema,GuestHubProfileConfigurationError} from "./guest-hub-profile-policy";
import {verifyGuestHubProfileReview,verifyGuestHubProfileCommand} from "./guest-hub-profile-signatures";

export const guestHubProfilePayloadBindingSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_PROFILE_PAYLOAD_V1"),id:guestHubIdSchema,organizationId:guestHubIdSchema,
 linkId:guestHubIdSchema,grantId:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,guestId:guestHubIdSchema,
 previousId:guestHubIdSchema.nullable(),version:z.number().int().positive().max(2147483647),
 commandKey:guestHubIdSchema,commandHash:guestHubFingerprintSchema,commandKeyVersion:z.string().min(1).max(120),
 grantFingerprint:guestHubFingerprintSchema,policyId:guestHubIdSchema,policyVersion:z.number().int().positive().max(2147483647),
 policyFingerprint:guestHubFingerprintSchema,sourceFingerprint:guestHubFingerprintSchema,createdAt:z.iso.datetime()
}).strict().superRefine((value,context)=>{if((value.version===1)!==(value.previousId===null))context.addIssue({code:"custom",path:["previousId"],message:"actual_profile_predecessor_required"});});
export type GuestHubProfilePayloadBinding=z.infer<typeof guestHubProfilePayloadBindingSchema>;
export const guestHubPrivateProfileSchema=z.object({schemaVersion:z.literal(1),values:guestHubProfileValuesSchema,acknowledged:z.boolean(),reviewFingerprint:guestHubProfileReviewTokenSchema}).strict();
export type GuestHubPrivateProfile=z.infer<typeof guestHubPrivateProfileSchema>;
function context(binding:GuestHubProfilePayloadBinding){return JSON.stringify(["alvillas-private-guest-profile-v1",binding]);}
export function guestHubStoredProfileReview(binding:GuestHubProfilePayloadBinding,payload:GuestHubPrivateProfile){
 return guestHubProfileReviewBindingSchema.parse({protocol:"NATIVE_GUEST_PROFILE_REVIEW_V1",organizationId:binding.organizationId,linkId:binding.linkId,reservationId:binding.reservationId,propertyId:binding.propertyId,guestId:binding.guestId,grantId:binding.grantId,grantFingerprint:binding.grantFingerprint,policyFingerprint:binding.policyFingerprint,sourceFingerprint:binding.sourceFingerprint,previousRevisionId:binding.previousId,idempotencyKey:binding.commandKey,values:payload.values,acknowledged:payload.acknowledged});
}
function boundPayload(raw:unknown,binding:GuestHubProfilePayloadBinding,env:NodeJS.ProcessEnv){
 const payload=guestHubPrivateProfileSchema.parse(raw),review=guestHubStoredProfileReview(binding,payload);
 verifyGuestHubProfileReview(review,payload.reviewFingerprint,env);
 if(!verifyGuestHubProfileCommand(review,payload.reviewFingerprint,binding.commandKeyVersion,binding.commandHash,env))throw new GuestHubProfileConfigurationError();
 return payload;
}
/** The complete immutable lineage is authenticated; contacts and review tokens stay inside AEAD. */
export function encryptGuestHubProfile(raw:unknown,rawBinding:GuestHubProfilePayloadBinding,env:NodeJS.ProcessEnv=process.env){
 let plain:Buffer|undefined;try{requirePrivatePayloadKeys(env,true,()=>new GuestHubProfileConfigurationError());const binding=guestHubProfilePayloadBindingSchema.parse(rawBinding),payload=boundPayload(raw,binding,env);plain=Buffer.from(JSON.stringify(payload));return encryptBytes(plain,context(binding),env);}catch{throw new GuestHubProfileConfigurationError();}finally{plain?.fill(0);}
}
export function decryptGuestHubProfile(ciphertext:Uint8Array,rawBinding:GuestHubProfilePayloadBinding,env:NodeJS.ProcessEnv=process.env){
 let plain:Buffer|undefined;try{requirePrivatePayloadKeys(env,false,()=>new GuestHubProfileConfigurationError());const binding=guestHubProfilePayloadBindingSchema.parse(rawBinding);plain=decryptBytes(ciphertext,context(binding),env);return boundPayload(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(plain)),binding,env);}catch{throw new GuestHubProfileConfigurationError();}finally{plain?.fill(0);}
}
