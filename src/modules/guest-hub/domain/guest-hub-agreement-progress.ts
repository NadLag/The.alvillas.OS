import {z} from "zod";
import {GuestHubAgreementAccessError} from "./guest-hub-agreement-policy";
import type {GuestHubAgreementOriginal} from "./guest-hub-agreement-source";

export const guestHubAgreementNativeStatusSchema=z.object({signatureId:z.uuid(),originalVersionId:z.uuid(),signatureState:z.enum(["DRAFT","SENT","VIEWED","SIGNED","DECLINED","EXPIRED"]),archiveState:z.enum(["AWAITING_COMPLETION","PENDING","COMPLETE"]),signedVersionId:z.uuid().nullable(),certificateVersionId:z.uuid().nullable(),distributionState:z.enum(["SENT","UNCERTAIN"]).nullable()}).strict();
export type GuestHubAgreementNativeStatus=z.infer<typeof guestHubAgreementNativeStatusSchema>;
export const guestHubAgreementProgressSchema=z.object({state:z.enum(["READY","REQUESTED","EMAIL_SENT","VIEWED","ARCHIVING","SIGNED","DECLINED","EXPIRED","UNCERTAIN","PREVIOUS_REQUEST"]),complete:z.boolean()}).strict();
/** A notice acknowledgement, provider email or unarchived completion never
 * satisfies the current agreement. Existing native proof owns that decision. */
export function guestHubAgreementProgress(original:GuestHubAgreementOriginal,raw:unknown,request:"NONE"|"CURRENT"|"PREVIOUS"){
 const native=guestHubAgreementNativeStatusSchema.parse(raw);
 if(native.signatureId!==original.signature.id||native.originalVersionId!==original.document.versionId)throw new GuestHubAgreementAccessError();
 const complete=native.signatureState==="SIGNED"&&native.archiveState==="COMPLETE"&&native.signedVersionId!==null&&native.certificateVersionId!==null&&native.signedVersionId!==native.certificateVersionId&&native.signedVersionId!==native.originalVersionId&&native.certificateVersionId!==native.originalVersionId;
 const state=request==="PREVIOUS"?"PREVIOUS_REQUEST":complete?"SIGNED":native.signatureState==="SIGNED"?"ARCHIVING":native.signatureState==="SENT"?"EMAIL_SENT":native.signatureState==="VIEWED"||native.signatureState==="DECLINED"||native.signatureState==="EXPIRED"?native.signatureState:native.distributionState==="UNCERTAIN"?"UNCERTAIN":request==="CURRENT"?"REQUESTED":"READY";
 return guestHubAgreementProgressSchema.parse({state,complete:state==="SIGNED"});
}
