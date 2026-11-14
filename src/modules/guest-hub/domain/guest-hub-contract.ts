import {z} from "zod";

export const guestHubIdSchema=z.uuid().transform(value=>value.toLowerCase());
export const guestHubFingerprintSchema=z.string().regex(/^[a-f0-9]{64}$/u);
export const guestHubTokenMaximumBytes=4096;
export const guestHubTokenTextSchema=z.string().max(guestHubTokenMaximumBytes).regex(/^alvillas-guest-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const guestHubCapabilityBindingSchema=z.object({organizationId:guestHubIdSchema,linkId:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,guestId:guestHubIdSchema,issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict().refine(value=>Date.parse(value.expiresAt)>Date.parse(value.issuedAt),{message:"guest_capability_expiry_after_issuance_required",path:["expiresAt"]});
export const guestHubCapabilityClaimsSchema=guestHubCapabilityBindingSchema.safeExtend({protocol:z.literal("NATIVE_RESERVATION_GUEST_CAPABILITY_V1"),nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/u)});
export type GuestHubCapabilityClaims=z.infer<typeof guestHubCapabilityClaimsSchema>;

const rationale=z.string().trim().min(1).max(1000).refine(value=>!/[\p{Cc}]/u.test(value.replaceAll("\n","").replaceAll("\r","").replaceAll("\t",""))).transform(value=>value.normalize("NFC"));
const originalCommand={idempotencyKey:guestHubIdSchema,reviewFingerprint:guestHubFingerprintSchema,reason:rationale};
export const guestHubIssueDraftSchema=z.object({reservationId:guestHubIdSchema}).strict();
export const guestHubIssueCommandSchema=guestHubIssueDraftSchema.extend(originalCommand);
export const guestHubRevokeDraftSchema=z.object({linkId:guestHubIdSchema}).strict();
export const guestHubRevokeCommandSchema=guestHubRevokeDraftSchema.extend(originalCommand);
export const guestHubRecoveryInputSchema=z.object({idempotencyKey:guestHubIdSchema,reservationId:guestHubIdSchema.optional()}).strict();
export const guestHubPublicInputSchema=z.object({token:guestHubTokenTextSchema}).strict();
export const guestHubDirectoryInputSchema=z.object({reservationId:guestHubIdSchema,cursor:z.string().max(6000).optional()}).strict();
export const guestHubStaffReceiptSchema=z.object({id:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),state:z.enum(["ACTIVE","EXPIRED","REVOKED","BLOCKED"]),replayed:z.boolean(),token:guestHubTokenTextSchema.optional()}).strict();
export const guestHubRecoveryResultSchema=z.discriminatedUnion("recorded",[
 guestHubStaffReceiptSchema.extend({recorded:z.literal(true),idempotencyKey:guestHubIdSchema}),
 z.object({recorded:z.literal(false),reservationId:guestHubIdSchema,idempotencyKey:guestHubIdSchema}).strict()
]);
export const guestHubRevocationRecoveryInputSchema=z.object({linkId:guestHubIdSchema,idempotencyKey:guestHubIdSchema}).strict();
export const guestHubRevocationRecoveryResultSchema=z.discriminatedUnion("recorded",[
 z.object({recorded:z.literal(true),id:guestHubIdSchema,linkId:guestHubIdSchema,idempotencyKey:guestHubIdSchema,createdAt:z.iso.datetime()}).strict(),
 z.object({recorded:z.literal(false),linkId:guestHubIdSchema,idempotencyKey:guestHubIdSchema,alreadyRevoked:z.boolean()}).strict()
]);
export const guestHubPublicViewSchema=z.object({id:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,checkIn:z.iso.date(),checkOut:z.iso.date(),expiresAt:z.iso.datetime(),timezone:z.string().min(1).max(120),state:z.literal("ACTIVE"),locale:z.enum(["en","fr","ar"])}).strict();
export const guestHubLinkSummarySchema=z.object({id:guestHubIdSchema,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),state:z.enum(["ACTIVE","EXPIRED","REVOKED","BLOCKED"]),originalCreator:z.boolean(),recoveryKey:guestHubIdSchema.optional(),canRevoke:z.boolean()}).strict();
export const guestHubWorkspaceSchema=z.object({reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,reference:z.string().min(1).max(200),locale:z.enum(["en","fr","ar"]),timezone:z.string().min(1).max(120),checkedAt:z.iso.datetime(),canCreate:z.boolean(),issuanceAvailable:z.boolean(),items:z.array(guestHubLinkSummarySchema).max(25),next:z.string().max(6000).nullable()}).strict();
