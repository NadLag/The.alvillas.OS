import {z} from "zod";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {guestHubAgreementPolicySchema} from "./guest-hub-agreement-policy";

/** A normalized projection supplied by canonical document/signature services.
 * Public commands never accept these source identities or recipient references. */
export const guestHubAgreementOriginalSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_AGREEMENT_ORIGINAL_V1"),organizationId:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,guestId:guestHubIdSchema,
 document:z.object({id:guestHubIdSchema,instanceId:guestHubIdSchema,versionId:guestHubIdSchema,typeKey:guestHubAgreementPolicySchema.shape.document_type_key,locale:z.enum(["en","fr","ar"]),sha256:guestHubFingerprintSchema,templateKey:guestHubAgreementPolicySchema.shape.template_key,templateId:guestHubIdSchema,templateVersionId:guestHubIdSchema}).strict(),
 signature:z.object({id:guestHubIdSchema,documentVersionId:guestHubIdSchema,guestRecipientId:guestHubIdSchema,guestReference:z.object({kind:z.literal("GUEST"),id:guestHubIdSchema}).strict(),guestIdentityFingerprint:guestHubFingerprintSchema}).strict()
}).strict();
export type GuestHubAgreementOriginal=z.infer<typeof guestHubAgreementOriginalSchema>;

