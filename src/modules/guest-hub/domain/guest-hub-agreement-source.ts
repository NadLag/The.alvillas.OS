import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import type {guestHubAgreementTemplate} from "./guest-hub-agreement-policy";
import {GuestHubAgreementAccessError} from "./guest-hub-agreement-policy";
import {guestHubAgreementOriginalSchema} from "./guest-hub-agreement-original";
export {guestHubAgreementOriginalSchema,type GuestHubAgreementOriginal} from "./guest-hub-agreement-original";

export function bindGuestHubAgreementOriginal(raw:unknown,source:{organizationId:string;reservationId:string;propertyId:string;guestId:string},selection:ReturnType<typeof guestHubAgreementTemplate>){
 const original=guestHubAgreementOriginalSchema.parse(raw);
 if(original.organizationId!==source.organizationId||original.reservationId!==source.reservationId||original.propertyId!==source.propertyId||original.guestId!==source.guestId||original.signature.guestReference.id!==source.guestId||original.signature.documentVersionId!==original.document.versionId||original.document.typeKey!==selection.documentTypeKey||original.document.templateKey!==selection.templateKey||original.document.templateVersionId!==selection.templateVersionId||original.document.locale!==selection.locale)throw new GuestHubAgreementAccessError();
 return{original,fingerprint:jsonbFingerprint(original),requestedLocale:selection.requestedLocale,documentLocale:original.document.locale};
}
