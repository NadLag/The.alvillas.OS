import {z} from "zod";
import {guestHubIdSchema} from "./guest-hub-contract";
import {guestHubProfileReviewBindingSchema,guestHubProfileReceiptSchema} from "./guest-hub-profile-contract";
import {guestHubProfilePayloadBindingSchema} from "./guest-hub-profile-payload-contract";
import {guestHubStayDetailsFieldSchema,guestHubStayDetailsValuesSchema,guestHubStayTravelMethodSchema} from "./guest-hub-stay-details-policy";
import {guestHubFormNoticeSchema} from "./guest-hub-form-policy";

const timezone=z.string().min(1).max(120),resolved=z.object({arrival:z.iso.datetime().nullable(),departure:z.iso.datetime().nullable()}).strict(),window=z.object({earliest:z.iso.date(),latest:z.iso.date()}).strict();
export const guestHubStayDetailsDraftSchema=z.object({idempotencyKey:guestHubIdSchema,values:guestHubStayDetailsValuesSchema,acknowledged:z.boolean()}).strict();
export const guestHubStayDetailsReviewTokenSchema=z.string().min(40).max(512).regex(/^guest-stay-details-review-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const guestHubStayDetailsReviewBindingSchema=z.object({...guestHubProfileReviewBindingSchema.shape,protocol:z.literal("NATIVE_GUEST_STAY_DETAILS_REVIEW_V1"),values:guestHubStayDetailsValuesSchema,timezone,resolved}).strict();
export type GuestHubStayDetailsReviewBinding=z.infer<typeof guestHubStayDetailsReviewBindingSchema>;
export const guestHubStayDetailsPayloadBindingSchema=z.object({...guestHubProfilePayloadBindingSchema.shape,protocol:z.literal("NATIVE_GUEST_STAY_DETAILS_PAYLOAD_V1")}).strict().superRefine((value,context)=>{if((value.version===1)!==(value.previousId===null))context.addIssue({code:"custom",path:["previousId"],message:"actual_stay_details_predecessor_required"});});
export type GuestHubStayDetailsPayloadBinding=z.infer<typeof guestHubStayDetailsPayloadBindingSchema>;
export const guestHubPrivateStayDetailsSchema=z.object({schemaVersion:z.literal(1),values:guestHubStayDetailsValuesSchema,timezone,resolved,acknowledged:z.boolean(),reviewFingerprint:guestHubStayDetailsReviewTokenSchema}).strict();
export type GuestHubPrivateStayDetails=z.infer<typeof guestHubPrivateStayDetailsSchema>;
export const guestHubStayDetailsSubmitSchema=guestHubStayDetailsDraftSchema.extend({reviewFingerprint:guestHubStayDetailsReviewTokenSchema}).strict();
export const guestHubStayDetailsRecoverySchema=z.object({idempotencyKey:guestHubIdSchema}).strict();
export const guestHubStayDetailsViewSchema=z.object({linkId:guestHubIdSchema,reservationId:guestHubIdSchema,grantId:guestHubIdSchema,previousRevisionId:guestHubIdSchema.nullable(),allowedFields:z.array(guestHubStayDetailsFieldSchema).min(1).max(6),requiredFields:z.array(guestHubStayDetailsFieldSchema).max(6),methods:z.array(guestHubStayTravelMethodSchema).max(5),dateWindows:z.object({arrival:window,departure:window}).strict(),timezone,notice:guestHubFormNoticeSchema,requireAcknowledgement:z.boolean(),values:guestHubStayDetailsValuesSchema}).strict();
export const guestHubStayDetailsReviewSchema=guestHubStayDetailsDraftSchema.extend({grantId:guestHubIdSchema,previousRevisionId:guestHubIdSchema.nullable(),timezone,resolved,reviewFingerprint:guestHubStayDetailsReviewTokenSchema}).strict();
export const guestHubStayDetailsReceiptSchema=guestHubProfileReceiptSchema;
export const guestHubStayDetailsRecoveryResultSchema=z.discriminatedUnion("recorded",[guestHubStayDetailsReceiptSchema.extend({recorded:z.literal(true)}).strict(),z.object({recorded:z.literal(false),linkId:guestHubIdSchema,idempotencyKey:guestHubIdSchema}).strict()]);
export function guestHubStoredStayDetailsReview(binding:GuestHubStayDetailsPayloadBinding,payload:GuestHubPrivateStayDetails){return guestHubStayDetailsReviewBindingSchema.parse({protocol:"NATIVE_GUEST_STAY_DETAILS_REVIEW_V1",organizationId:binding.organizationId,linkId:binding.linkId,reservationId:binding.reservationId,propertyId:binding.propertyId,guestId:binding.guestId,grantId:binding.grantId,grantFingerprint:binding.grantFingerprint,policyFingerprint:binding.policyFingerprint,sourceFingerprint:binding.sourceFingerprint,previousRevisionId:binding.previousId,idempotencyKey:binding.commandKey,values:payload.values,acknowledged:payload.acknowledged,timezone:payload.timezone,resolved:payload.resolved});}
