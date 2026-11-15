import {z} from "zod";
import {documentUploadInput,documentSourceReferenceSchema,DocumentConflictError} from "./document-command";
import {validateGeneratedPdf} from "./document-pdf";

export const nativeGuestIdentityDocumentProtocol="ALVILLAS_NATIVE_GUEST_IDENTITY_DOCUMENT_V1";
export const nativeGuestIdentityReferenceSchema=z.object({protocol:z.literal(nativeGuestIdentityDocumentProtocol),captureId:z.uuid(),fileId:z.uuid()}).strict();
export const nativeGuestIdentityContentTypeSchema=documentUploadInput.shape.contentType.extract(["application/pdf","image/png","image/jpeg"]);
export const nativeGuestIdentityDocumentProvenanceSchema=z.object({
 protocol:z.literal(nativeGuestIdentityDocumentProtocol),origin:z.literal("GUEST_CAPABILITY"),
 organizationId:z.uuid(),linkId:z.uuid(),grantId:z.uuid(),captureId:z.uuid(),fileId:z.uuid(),delegatedBy:z.uuid()
}).strict();
export function nativeGuestIdentityDocumentFileName(fileId:string,contentType:unknown){
 const id=z.uuid().parse(fileId),type=nativeGuestIdentityContentTypeSchema.parse(contentType);
 return"identity-"+id+"."+({"application/pdf":"pdf","image/png":"png","image/jpeg":"jpg"}as const)[type];
}
/** Internal original-file producer. The ordinary strict public upload schema rejects this marker. */
export const nativeGuestIdentityDocumentUploadInput=documentUploadInput.safeExtend({
 documentId:z.uuid(),source:documentSourceReferenceSchema.extend({kind:z.literal("RESERVATION")}),
 kind:z.literal("FILE"),contentType:nativeGuestIdentityContentTypeSchema,
 templateKey:z.null(),supersedesId:z.null(),effectiveFrom:z.null(),guestIdentity:nativeGuestIdentityReferenceSchema
}).superRefine((input,context)=>{
 if(input.fileName!==nativeGuestIdentityDocumentFileName(input.guestIdentity.fileId,input.contentType))context.addIssue({code:"custom",path:["fileName"],message:"neutral_original_identity_filename_required"});
 if(input.idempotencyKey!==input.guestIdentity.fileId)context.addIssue({code:"custom",path:["idempotencyKey"],message:"original_identity_file_nonce_required"});
});

/** Media framing complements canonical size, byte and chunk hashes; it performs no OCR. */
export function assertNativeGuestIdentityMediaFraming(contentType:unknown,bytes:Uint8Array,maximumBytes:number){
 try{
  const type=nativeGuestIdentityContentTypeSchema.parse(contentType);documentUploadInput.shape.fileSize.parse(maximumBytes);
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>maximumBytes)throw new DocumentConflictError();
  if(type==="application/pdf"){const checked=validateGeneratedPdf(bytes,maximumBytes);checked.fill(0);return;}
  const prefix=type==="image/png"?[137,80,78,71,13,10,26,10]:[255,216,255],suffix=type==="image/png"?[0,0,0,0,73,69,78,68,174,66,96,130]:[255,217];
  if(bytes.length<prefix.length+suffix.length||prefix.some((value,index)=>bytes[index]!==value)||suffix.some((value,index)=>bytes[bytes.length-suffix.length+index]!==value))throw new DocumentConflictError();
 }catch{throw new DocumentConflictError();}
}
