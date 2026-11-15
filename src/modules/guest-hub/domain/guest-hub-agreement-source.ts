import {z} from "zod";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import type {guestHubAgreementTemplate} from "./guest-hub-agreement-policy";
import {GuestHubAgreementAccessError} from "./guest-hub-agreement-policy";

/** A normalized projection supplied by canonical document/signature services.
 * Public commands never accept these source identities or recipient references. */
export const guestHubAgreementOriginalSchema=z.object({
 protocol:z.literal("NATIVE_GUEST_AGREEMENT_ORIGINAL_V1"),organizationId:guestHubIdSchema,reservationId:guestHubIdSchema,propertyId:guestHubIdSchema,guestId:guestHubIdSchema,
 document:z.object({id:guestHubIdSchema,instanceId:guestHubIdSchema,versionId:guestHubIdSchema,typeKey:z.string().min(1).max(120),locale:z.enum(["en","fr","ar"]),sha256:guestHubFingerprintSchema,templateKey:z.string().min(1).max(120),templateId:guestHubIdSchema,templateVersionId:guestHubIdSchema}).strict(),
 signature:z.object({id:guestHubIdSchema,documentVersionId:guestHubIdSchema,guestRecipientId:guestHubIdSchema,guestReference:z.object({kind:z.literal("GUEST"),id:guestHubIdSchema}).strict(),guestIdentityFingerprint:guestHubFingerprintSchema}).strict()
}).strict();
export type GuestHubAgreementOriginal=z.infer<typeof guestHubAgreementOriginalSchema>;

export function bindGuestHubAgreementOriginal(raw:unknown,source:{organizationId:string;reservationId:string;propertyId:string;guestId:string},selection:ReturnType<typeof guestHubAgreementTemplate>){
 const original=guestHubAgreementOriginalSchema.parse(raw);
 if(original.organizationId!==source.organizationId||original.reservationId!==source.reservationId||original.propertyId!==source.propertyId||original.guestId!==source.guestId||original.signature.guestReference.id!==source.guestId||original.signature.documentVersionId!==original.document.versionId||original.document.typeKey!==selection.documentTypeKey||original.document.templateKey!==selection.templateKey||original.document.templateVersionId!==selection.templateVersionId||original.document.locale!==selection.locale)throw new GuestHubAgreementAccessError();
 return{original,fingerprint:jsonbFingerprint(original),requestedLocale:selection.requestedLocale,documentLocale:original.document.locale};
}
