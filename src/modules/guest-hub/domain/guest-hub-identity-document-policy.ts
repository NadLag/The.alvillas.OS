import {z} from "zod";
import {documentUploadReviewInput} from "@/modules/documents/domain/document-command";
import {documentRetentionTagKey} from "@/modules/documents/domain/document-retention-policy";
import {guestHubFormBudgetSchema,guestHubFormNoticeSchema,guestHubFormReferenceSchema,retainsGuestHubFormPurpose} from "./guest-hub-form-policy";

export const guestHubIdentityDocumentPolicyKey="guest_hub.identity_documents";
export const guestHubIdentityDocumentKindSchema=z.enum(["PASSPORT","NATIONAL_ID"]);
export const guestHubIdentityDocumentPartSchema=z.enum(["IDENTITY_PAGE","FRONT","BACK"]);
export const guestHubIdentityDocumentContentTypeSchema=z.enum(["application/pdf","image/png","image/jpeg"]);
const distinct=<T>(values:readonly T[])=>new Set(values).size===values.length;
const parts=z.array(guestHubIdentityDocumentPartSchema).min(1).max(3).refine(distinct);
const approvedType=z.object({
 kind:guestHubIdentityDocumentKindSchema,
 document_type_key:documentUploadReviewInput.shape.typeKey,
 allowed_parts:parts,
 required_parts:z.array(guestHubIdentityDocumentPartSchema).max(3).refine(distinct),
 retention_tag_keys:z.array(documentRetentionTagKey).min(1).max(64).refine(distinct)
}).strict().refine(value=>value.required_parts.every(part=>value.allowed_parts.includes(part)),{message:"required_identity_parts_must_be_approved"});

/** Collection is unavailable until the owner supplies the actual processing and retention decisions. */
export const guestHubIdentityDocumentPolicySchema=z.object({
 source:z.literal("NATIVE_GUEST_IDENTITY_DOCUMENTS"),
 history:z.literal("APPEND_ONLY_RESERVATION_IDENTITY_CAPTURES"),
 storage:z.literal("EXISTING_ENCRYPTED_DOCUMENT_ARCHIVE"),
 enabled:z.boolean(),
 processing_approval_reference:guestHubFormReferenceSchema.nullable(),
 retention_approval_reference:guestHubFormReferenceSchema.nullable(),
 notice:guestHubFormNoticeSchema.nullable(),
 require_acknowledgement:z.boolean(),
 document_types:z.array(approvedType).max(2).refine(values=>distinct(values.map(value=>value.kind))),
 required_document_kinds:z.array(guestHubIdentityDocumentKindSchema).max(2).refine(distinct),
 content_types:z.array(guestHubIdentityDocumentContentTypeSchema).min(1).max(3).refine(distinct),
 max_document_bytes:documentUploadReviewInput.shape.fileSize,
 max_captures:z.number().int().positive().max(2147483647),
 submissions:guestHubFormBudgetSchema,
 uploads:guestHubFormBudgetSchema
}).strict().superRefine((value,context)=>{
 if(value.enabled&&(!value.processing_approval_reference||!value.retention_approval_reference||!value.notice||!value.document_types.length))context.addIssue({code:"custom",path:["processing_approval_reference"],message:"explicit_identity_processing_retention_notice_and_types_required"});
 if(value.required_document_kinds.some(kind=>!value.document_types.some(type=>type.kind===kind)))context.addIssue({code:"custom",path:["required_document_kinds"],message:"required_identity_kinds_must_be_approved"});
});
export type GuestHubIdentityDocumentPolicy=z.infer<typeof guestHubIdentityDocumentPolicySchema>;
export class GuestHubIdentityDocumentAccessError extends Error{constructor(){super("guest_identity_document_access_unavailable");}}
export class GuestHubIdentityDocumentConflictError extends Error{constructor(){super("guest_identity_document_review_changed");}}
export class GuestHubIdentityDocumentConfigurationError extends Error{constructor(){super("guest_identity_document_configuration_unavailable");}}

/** A captured grant can narrow collection, but cannot acquire another document type or retention purpose. */
export function effectiveGuestHubIdentityDocumentPolicy(captured:GuestHubIdentityDocumentPolicy,current:GuestHubIdentityDocumentPolicy){
 const original=guestHubIdentityDocumentPolicySchema.parse(captured),latest=guestHubIdentityDocumentPolicySchema.parse(current);
 if(!retainsGuestHubFormPurpose(original,latest)||!latest.notice||!original.retention_approval_reference||original.retention_approval_reference!==latest.retention_approval_reference)throw new GuestHubIdentityDocumentAccessError();
 const documents=original.document_types.flatMap(type=>{
  const active=latest.document_types.find(value=>value.kind===type.kind);
  if(!active||type.document_type_key!==active.document_type_key||JSON.stringify([...type.retention_tag_keys].sort())!==JSON.stringify([...active.retention_tag_keys].sort()))return[];
  const allowedParts=type.allowed_parts.filter(part=>active.allowed_parts.includes(part)),requiredParts=[...new Set([...type.required_parts,...active.required_parts])];
  if(!allowedParts.length||requiredParts.some(part=>!allowedParts.includes(part)))return[];
  return[{kind:type.kind,documentTypeKey:type.document_type_key,allowedParts,requiredParts,retentionTagKeys:[...type.retention_tag_keys].sort()}];
 });
 const requiredKinds=[...new Set([...original.required_document_kinds,...latest.required_document_kinds])],contentTypes=original.content_types.filter(type=>latest.content_types.includes(type));
 if(!documents.length||!contentTypes.length||requiredKinds.some(kind=>!documents.some(document=>document.kind===kind)))throw new GuestHubIdentityDocumentAccessError();
 return{documents,requiredKinds,contentTypes,maxDocumentBytes:Math.min(original.max_document_bytes,latest.max_document_bytes),maxCaptures:Math.min(original.max_captures,latest.max_captures),notice:latest.notice,retentionApprovalReference:latest.retention_approval_reference,requireAcknowledgement:original.require_acknowledgement||latest.require_acknowledgement,limits:[original.submissions,latest.submissions],uploadLimits:[original.uploads,latest.uploads]};
}
