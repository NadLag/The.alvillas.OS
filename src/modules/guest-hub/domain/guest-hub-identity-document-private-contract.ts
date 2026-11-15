import {z} from "zod";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {guestHubProfilePayloadBindingSchema} from "./guest-hub-profile-payload-contract";
import {guestHubIdentityDocumentFilesSchema,guestHubIdentityDocumentReviewInputSchema,guestHubIdentityDocumentReviewTokenSchema,guestHubIdentityDocumentMaximumJsonBytes,guestHubIdentityDocumentMaximumFiles} from "./guest-hub-identity-document-contract";
import {guestHubIdentityDocumentKindSchema,guestHubIdentityDocumentPartSchema} from "./guest-hub-identity-document-policy";

export const guestHubIdentityDocumentReviewBindingSchema=guestHubIdentityDocumentReviewInputSchema.extend({
 protocol:z.literal("NATIVE_GUEST_IDENTITY_DOCUMENT_REVIEW_V1"),organizationId:guestHubIdSchema,linkId:guestHubIdSchema,
 reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,guestId:guestHubIdSchema,grantId:guestHubIdSchema,
 grantFingerprint:guestHubFingerprintSchema,formFingerprint:guestHubFingerprintSchema,
 policyFingerprint:guestHubFingerprintSchema,sourceFingerprint:guestHubFingerprintSchema
}).strict();
export type GuestHubIdentityDocumentReviewBinding=z.infer<typeof guestHubIdentityDocumentReviewBindingSchema>;
export const guestHubIdentityDocumentPayloadBindingSchema=z.object({
 ...guestHubProfilePayloadBindingSchema.shape,protocol:z.literal("NATIVE_GUEST_IDENTITY_DOCUMENT_CAPTURE_V1"),
 formFingerprint:guestHubFingerprintSchema,manifestFingerprint:guestHubFingerprintSchema
}).strict().superRefine((value,context)=>{
 if((value.version===1)!==(value.previousId===null))context.addIssue({code:"custom",path:["previousId"],message:"actual_identity_capture_predecessor_required"});
});
export type GuestHubIdentityDocumentPayloadBinding=z.infer<typeof guestHubIdentityDocumentPayloadBindingSchema>;
export const guestHubPrivateIdentityDocumentSchema=z.object({
 schemaVersion:z.literal(1),files:guestHubIdentityDocumentFilesSchema,acknowledged:z.boolean(),reviewFingerprint:guestHubIdentityDocumentReviewTokenSchema
}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=guestHubIdentityDocumentMaximumJsonBytes,{message:"bounded_private_identity_manifest_required"});
export type GuestHubPrivateIdentityDocument=z.infer<typeof guestHubPrivateIdentityDocumentSchema>;

const manifestItem=z.object({id:guestHubIdSchema,kind:guestHubIdentityDocumentKindSchema,part:guestHubIdentityDocumentPartSchema}).strict();
export const guestHubIdentityDocumentManifestSchema=z.array(manifestItem).min(1).max(guestHubIdentityDocumentMaximumFiles).superRefine((items,context)=>{
 const ids=new Set<string>(),sides=new Set<string>();for(const[index,item]of items.entries()){
  if(ids.has(item.id)||sides.has(item.kind+":"+item.part))context.addIssue({code:"custom",path:[index],message:"distinct_original_identity_manifest_required"});
  ids.add(item.id);sides.add(item.kind+":"+item.part);
 }
});
export function guestHubStoredIdentityDocumentReview(binding:GuestHubIdentityDocumentPayloadBinding,payload:GuestHubPrivateIdentityDocument){
 return guestHubIdentityDocumentReviewBindingSchema.parse({
  protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_REVIEW_V1",organizationId:binding.organizationId,linkId:binding.linkId,
  reservationId:binding.reservationId,propertyId:binding.propertyId,guestId:binding.guestId,grantId:binding.grantId,
  grantFingerprint:binding.grantFingerprint,formFingerprint:binding.formFingerprint,policyFingerprint:binding.policyFingerprint,sourceFingerprint:binding.sourceFingerprint,
  previousCaptureId:binding.previousId,idempotencyKey:binding.commandKey,files:payload.files,acknowledged:payload.acknowledged
 });
}
