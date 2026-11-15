import {z} from "zod";
import {documentUploadReviewInput,documentUploadChunkBytes,documentSingleBodyBytes} from "@/modules/documents";
import {guestHubIdSchema} from "./guest-hub-contract";
import {guestHubIdentityDocumentKindSchema,guestHubIdentityDocumentPartSchema,guestHubIdentityDocumentContentTypeSchema} from "./guest-hub-identity-document-policy";
import type {effectiveGuestHubIdentityDocumentArchive} from "./guest-hub-identity-document-archive";

// This framing bound accommodates all six distinct kind/side descriptors and their canonical chunk hashes.
// Existing profile and stay-details body limits are unchanged; no file bytes enter this JSON protocol.
export const guestHubIdentityDocumentMaximumJsonBytes=32768;
export const guestHubIdentityDocumentMaximumFiles=guestHubIdentityDocumentKindSchema.options.length*guestHubIdentityDocumentPartSchema.options.length;
export const guestHubIdentityDocumentFileSchema=z.object({
 kind:guestHubIdentityDocumentKindSchema,part:guestHubIdentityDocumentPartSchema,
 contentType:guestHubIdentityDocumentContentTypeSchema,fileSize:documentUploadReviewInput.shape.fileSize,
 sha256:documentUploadReviewInput.shape.sha256,parts:documentUploadReviewInput.shape.parts
}).strict().superRefine((value,context)=>{
 if(value.fileSize>documentSingleBodyBytes&&!value.parts)context.addIssue({code:"custom",path:["parts"],message:"bounded_document_parts_required"});
 if(value.parts&&value.parts.hashes.length!==Math.ceil(value.fileSize/documentUploadChunkBytes))context.addIssue({code:"custom",path:["parts"],message:"exact_document_part_count_required"});
});
export const guestHubIdentityDocumentFilesSchema=z.array(guestHubIdentityDocumentFileSchema).min(1).max(guestHubIdentityDocumentMaximumFiles).superRefine((files,context)=>{
 const seen=new Set<string>();for(const[index,file]of files.entries()){const key=file.kind+":"+file.part;if(seen.has(key))context.addIssue({code:"custom",path:[index,"part"],message:"distinct_identity_document_parts_required"});seen.add(key);}
});
export const guestHubIdentityDocumentDraftSchema=z.object({previousCaptureId:guestHubIdSchema.nullable(),files:guestHubIdentityDocumentFilesSchema,acknowledged:z.boolean()}).strict();
export const guestHubIdentityDocumentReviewTokenSchema=z.string().min(40).max(512).regex(/^guest-identity-documents-review-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const guestHubIdentityDocumentReviewInputSchema=guestHubIdentityDocumentDraftSchema.extend({idempotencyKey:guestHubIdSchema}).strict();
export const guestHubIdentityDocumentSubmitSchema=guestHubIdentityDocumentReviewInputSchema.extend({reviewFingerprint:guestHubIdentityDocumentReviewTokenSchema}).strict();
export const guestHubIdentityDocumentRecoverySchema=z.object({idempotencyKey:guestHubIdSchema}).strict();
export type GuestHubIdentityDocumentDraft=z.infer<typeof guestHubIdentityDocumentDraftSchema>;

/** Validate the actual selected files against authenticated, intersected canonical archive constraints. */
export function validateGuestHubIdentityDocumentSelection(raw:unknown,policy:ReturnType<typeof effectiveGuestHubIdentityDocumentArchive>){
 return guestHubIdentityDocumentDraftSchema.superRefine((value,context)=>{
  if(policy.requireAcknowledgement&&!value.acknowledged)context.addIssue({code:"custom",path:["acknowledged"],message:"identity_acknowledgement_required"});
  for(const[index,file]of value.files.entries()){
   const document=policy.documents.find(item=>item.kind===file.kind);
   if(!document){context.addIssue({code:"custom",path:["files",index,"kind"],message:"identity_kind_unavailable"});continue;}
   if(!document.allowedParts.includes(file.part))context.addIssue({code:"custom",path:["files",index,"part"],message:"identity_part_unavailable"});
   if(!document.contentTypes.includes(file.contentType))context.addIssue({code:"custom",path:["files",index,"contentType"],message:"identity_content_type_unavailable"});
   if(file.fileSize>document.maxBytes)context.addIssue({code:"custom",path:["files",index,"fileSize"],message:"identity_file_too_large"});
  }
  for(const kind of policy.requiredKinds)if(!value.files.some(file=>file.kind===kind))context.addIssue({code:"custom",path:["files"],message:"identity_required_kind_missing",params:{kind}});
  for(const document of policy.documents)if(value.files.some(file=>file.kind===document.kind))for(const part of document.requiredParts)if(!value.files.some(file=>file.kind===document.kind&&file.part===part))context.addIssue({code:"custom",path:["files"],message:"identity_required_part_missing",params:{kind:document.kind,part}});
 }).parse(raw);
}
