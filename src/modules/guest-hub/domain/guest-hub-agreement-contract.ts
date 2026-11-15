import {z} from "zod";
import {guestHubIdSchema as id,guestHubFingerprintSchema as fingerprint} from "./guest-hub-contract";
import {guestHubFormNoticeSchema} from "./guest-hub-form-policy";
import {guestHubAgreementOriginalSchema} from "./guest-hub-agreement-source";

export const guestHubAgreementLocaleSchema=z.enum(["en","fr","ar"]);
const timestamp=z.iso.datetime(),reason=z.string().trim().min(1).max(1000);
const selection=z.discriminatedUnion("decision",[
 z.object({decision:z.literal("GRANTED"),preparationId:id,locale:guestHubAgreementLocaleSchema}).strict(),
 z.object({decision:z.literal("WITHDRAWN"),preparationId:z.null(),locale:z.null()}).strict()
]);
export const guestHubAgreementReleaseDraftSchema=z.object({linkId:id,selection}).strict();
export const guestHubAgreementReleaseCommandSchema=guestHubAgreementReleaseDraftSchema.extend({idempotencyKey:id,reviewFingerprint:fingerprint,reason}).strict();
export const guestHubAgreementReleaseRecoverySchema=z.object({linkId:id,idempotencyKey:id}).strict();
export const guestHubAgreementReleaseBindingSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_AGREEMENT_RELEASE_V1"),id,organizationId:id,linkId:id,reservationId:id,propertyId:id,guestId:id,
 previousId:id.nullable(),version:z.number().int().positive(),decision:z.enum(["GRANTED","WITHDRAWN"]),
 preparationId:id.nullable(),requestedLocale:guestHubAgreementLocaleSchema.nullable(),originalFingerprint:fingerprint.nullable(),documentAuthorityFingerprint:fingerprint.nullable(),
 linkTokenHash:fingerprint,policyId:id.nullable(),policyVersion:z.number().int().positive().nullable(),policyFingerprint:fingerprint.nullable(),sourceFingerprint:fingerprint,authorizationCapFingerprint:fingerprint,
 commandKey:id,commandHash:fingerprint,reviewFingerprint:fingerprint,createdBy:id,createdAt:timestamp,expiresAt:timestamp
}).strict().superRefine((value,ctx)=>{
 if((value.version===1)!==(value.previousId===null))ctx.addIssue({code:"custom",message:"original_agreement_release_predecessor_required"});
 const granted=value.decision==="GRANTED";
 for(const key of ["preparationId","requestedLocale","originalFingerprint","documentAuthorityFingerprint","policyId","policyVersion","policyFingerprint"]as const)
  if(granted===(value[key]===null))ctx.addIssue({code:"custom",path:[key],message:"exact_agreement_release_selection_required"});
 if(granted&&value.expiresAt<=value.createdAt)ctx.addIssue({code:"custom",message:"unexpired_agreement_release_required"});
});
export type GuestHubAgreementReleaseBinding=z.infer<typeof guestHubAgreementReleaseBindingSchema>;
export const guestHubAgreementReleaseReceiptSchema=z.object({id,linkId:id,reservationId:id,propertyId:id,decision:z.enum(["GRANTED","WITHDRAWN"]),version:z.number().int().positive(),idempotencyKey:id,createdAt:timestamp,expiresAt:timestamp,replayed:z.boolean()}).strict();

// Guests select neither a document nor a recipient. A processing acknowledgement
// requests the existing signature email; it is never evidence of a signature.
export const guestHubAgreementDraftSchema=z.object({idempotencyKey:id,locale:guestHubAgreementLocaleSchema,acknowledged:z.literal(true)}).strict();
export const guestHubAgreementReviewTokenSchema=z.string().min(40).max(512).regex(/^guest-agreement-review-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const guestHubAgreementReviewBindingSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_AGREEMENT_REQUEST_REVIEW_V1"),organizationId:id,linkId:id,reservationId:id,propertyId:id,guestId:id,releaseId:id,releaseFingerprint:fingerprint,
 preparationId:id,originalFingerprint:fingerprint,policyFingerprint:fingerprint,sourceFingerprint:fingerprint,idempotencyKey:id,locale:guestHubAgreementLocaleSchema,documentLocale:guestHubAgreementLocaleSchema,
 acknowledged:z.literal(true),renderedFingerprint:fingerprint
}).strict();
export const guestHubAgreementPayloadBindingSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_AGREEMENT_REQUEST_PAYLOAD_V1"),id,organizationId:id,linkId:id,reservationId:id,propertyId:id,guestId:id,releaseId:id,releaseFingerprint:fingerprint,preparationId:id,
 commandKey:id,commandHash:fingerprint,commandKeyVersion:z.string().min(1).max(120),originalFingerprint:fingerprint,
 policyId:id,policyVersion:z.number().int().positive(),policyFingerprint:fingerprint,sourceFingerprint:fingerprint,requestedLocale:guestHubAgreementLocaleSchema,documentLocale:guestHubAgreementLocaleSchema,createdAt:timestamp
}).strict();
export type GuestHubAgreementPayloadBinding=z.infer<typeof guestHubAgreementPayloadBindingSchema>;
const text=guestHubFormNoticeSchema.shape.title.shape.en;
export const guestHubAgreementRenderedNoticeSchema=z.object({title:text,paragraphs:z.array(text).min(1).max(30)}).strict();
export const guestHubPrivateAgreementRequestSchema=z.object({schemaVersion:z.literal(1),original:guestHubAgreementOriginalSchema,notice:guestHubAgreementRenderedNoticeSchema,acknowledged:z.literal(true),reviewFingerprint:guestHubAgreementReviewTokenSchema}).strict();
export type GuestHubPrivateAgreementRequest=z.infer<typeof guestHubPrivateAgreementRequestSchema>;
export const guestHubAgreementSubmitSchema=guestHubAgreementDraftSchema.extend({reviewFingerprint:guestHubAgreementReviewTokenSchema}).strict();
export const guestHubAgreementRecoverySchema=z.object({idempotencyKey:id}).strict();
