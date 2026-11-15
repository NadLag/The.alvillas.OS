import {z} from "zod";

const id=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/u);
/** Retained native provenance, constructed by application composition only.
 * Ordinary staff/public distribution commands cannot supply this namespace. */
export const nativeGuestAgreementDistributionProvenanceSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_AGREEMENT_DISTRIBUTION_ORIGIN_V1"),organizationId:id,guestRequestId:id,linkId:id,releaseId:id,preparationId:id,reservationId:id,propertyId:id,guestId:id,delegatedBy:id,
 releaseFingerprint:sha,originalFingerprint:sha,payloadSha256:sha
}).strict();
export type NativeGuestAgreementDistributionProvenance=z.infer<typeof nativeGuestAgreementDistributionProvenanceSchema>;
