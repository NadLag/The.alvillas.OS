import {z} from "zod";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {guestHubProfileValuesSchema,guestHubProfileNoticeSchema} from "./guest-hub-profile-policy";

export const guestHubProfileReviewBindingSchema=z.object({protocol:z.literal("NATIVE_GUEST_PROFILE_REVIEW_V1"),organizationId:guestHubIdSchema,linkId:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,guestId:guestHubIdSchema,grantId:guestHubIdSchema,grantFingerprint:guestHubFingerprintSchema,policyFingerprint:guestHubFingerprintSchema,sourceFingerprint:guestHubFingerprintSchema,previousRevisionId:guestHubIdSchema.nullable(),idempotencyKey:guestHubIdSchema,values:guestHubProfileValuesSchema,acknowledged:z.boolean()}).strict();
export type GuestHubProfileReviewBinding=z.infer<typeof guestHubProfileReviewBindingSchema>;
export const guestHubProfileDraftSchema=z.object({idempotencyKey:guestHubIdSchema,values:guestHubProfileValuesSchema,acknowledged:z.boolean()}).strict();
export const guestHubProfileReviewTokenSchema=z.string().min(40).max(512).regex(/^guest-profile-review-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const guestHubProfileSubmitSchema=guestHubProfileDraftSchema.extend({reviewFingerprint:guestHubProfileReviewTokenSchema}).strict();
export const guestHubProfileRecoverySchema=z.object({idempotencyKey:guestHubIdSchema}).strict();
export const guestHubProfileViewSchema=z.object({linkId:guestHubIdSchema,reservationId:guestHubIdSchema,grantId:guestHubIdSchema,previousRevisionId:guestHubIdSchema.nullable(),allowedFields:z.array(z.enum(["displayName","email","phone","preferredLocale"])).min(1).max(4),requiredFields:z.array(z.enum(["displayName","email","phone","preferredLocale"])).max(4),notice:guestHubProfileNoticeSchema,requireAcknowledgement:z.boolean(),values:guestHubProfileValuesSchema}).strict();
export const guestHubProfileReceiptSchema=z.object({id:guestHubIdSchema,linkId:guestHubIdSchema,reservationId:guestHubIdSchema,version:z.number().int().positive(),idempotencyKey:guestHubIdSchema,createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export const guestHubProfileReviewSchema=guestHubProfileDraftSchema.extend({grantId:guestHubIdSchema,previousRevisionId:guestHubIdSchema.nullable(),reviewFingerprint:guestHubProfileReviewTokenSchema}).strict();
export const guestHubProfileRecoveryResultSchema=z.discriminatedUnion("recorded",[guestHubProfileReceiptSchema.extend({recorded:z.literal(true)}).strict(),z.object({recorded:z.literal(false),linkId:guestHubIdSchema,idempotencyKey:guestHubIdSchema}).strict()]);

export {guestHubFormGrantBindingSchema,type GuestHubFormGrantBinding,guestHubFormGrantDraftSchema as guestHubProfileGrantDraftSchema,guestHubFormGrantCommandSchema as guestHubProfileGrantCommandSchema,guestHubFormGrantRecoverySchema as guestHubProfileGrantRecoverySchema,guestHubFormGrantReceiptSchema as guestHubProfileGrantReceiptSchema,guestHubFormGrantStatusSchema as guestHubProfileGrantStatusSchema,guestHubFormGrantReviewSchema as guestHubProfileGrantReviewSchema,guestHubFormGrantRecoveryResultSchema as guestHubProfileGrantRecoveryResultSchema} from "./guest-hub-form-grant-contract";
