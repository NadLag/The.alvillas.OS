import {z} from "zod";
import {guestHubIdSchema} from "./guest-hub-contract";
import {guestHubFormNoticeSchema} from "./guest-hub-form-policy";
import {guestHubIdentityDocumentKindSchema,guestHubIdentityDocumentPartSchema,guestHubIdentityDocumentContentTypeSchema} from "./guest-hub-identity-document-policy";
import {guestHubIdentityDocumentReviewInputSchema,guestHubIdentityDocumentReviewTokenSchema,guestHubIdentityDocumentFileSchema} from "./guest-hub-identity-document-contract";
import {guestHubIdentityDocumentManifestSchema} from "./guest-hub-identity-document-private-contract";

export const guestHubIdentityCaptureViewSchema=z.object({
 linkId:guestHubIdSchema,reservationId:guestHubIdSchema,grantId:guestHubIdSchema,previousCaptureId:guestHubIdSchema.nullable(),
 captureCount:z.number().int().nonnegative().max(2147483647),maxCaptures:z.number().int().positive().max(2147483647),
 originalCapture:z.object({id:guestHubIdSchema,files:guestHubIdentityDocumentManifestSchema}).strict().optional(),
 notice:guestHubFormNoticeSchema,requireAcknowledgement:z.boolean(),requiredKinds:z.array(guestHubIdentityDocumentKindSchema).max(2),
 documentKinds:z.array(z.object({kind:guestHubIdentityDocumentKindSchema,allowedParts:z.array(guestHubIdentityDocumentPartSchema).min(1).max(3),requiredParts:z.array(guestHubIdentityDocumentPartSchema).max(3),contentTypes:z.array(guestHubIdentityDocumentContentTypeSchema).min(1).max(3),maxBytes:guestHubIdentityDocumentFileSchema.shape.fileSize}).strict()).min(1).max(guestHubIdentityDocumentKindSchema.options.length)
}).strict();
export const guestHubIdentityCaptureReviewSchema=guestHubIdentityDocumentReviewInputSchema.extend({grantId:guestHubIdSchema,reviewFingerprint:guestHubIdentityDocumentReviewTokenSchema}).strict();
/** A capture intent acknowledges persisted descriptors; canonical publication is acknowledged separately. */
export const guestHubIdentityCaptureReceiptSchema=z.object({
 id:guestHubIdSchema,linkId:guestHubIdSchema,reservationId:guestHubIdSchema,grantId:guestHubIdSchema,version:z.number().int().positive().max(2147483647),
 idempotencyKey:guestHubIdSchema,createdAt:z.iso.datetime(),files:guestHubIdentityDocumentManifestSchema,replayed:z.boolean()
}).strict();
export const guestHubIdentityCaptureRecoverySchema=z.discriminatedUnion("recorded",[
 guestHubIdentityCaptureReceiptSchema.extend({recorded:z.literal(true)}),
 z.object({recorded:z.literal(false),linkId:guestHubIdSchema,idempotencyKey:guestHubIdSchema}).strict()
]);
