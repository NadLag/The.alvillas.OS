import {z} from "zod";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {guestHubProfileReviewBindingSchema,guestHubProfileReviewTokenSchema} from "./guest-hub-profile-contract";
import {guestHubProfileValuesSchema} from "./guest-hub-profile-policy";
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
export function guestHubStoredProfileReview(binding:GuestHubProfilePayloadBinding,payload:GuestHubPrivateProfile){
 return guestHubProfileReviewBindingSchema.parse({protocol:"NATIVE_GUEST_PROFILE_REVIEW_V1",organizationId:binding.organizationId,linkId:binding.linkId,reservationId:binding.reservationId,propertyId:binding.propertyId,guestId:binding.guestId,grantId:binding.grantId,grantFingerprint:binding.grantFingerprint,policyFingerprint:binding.policyFingerprint,sourceFingerprint:binding.sourceFingerprint,previousRevisionId:binding.previousId,idempotencyKey:binding.commandKey,values:payload.values,acknowledged:payload.acknowledged});
}
