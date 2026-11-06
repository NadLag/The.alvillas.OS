import { z } from "zod";
import { fieldUploadChunkBytes,fieldUploadMaximumParts,privateUploadSingleRequestBytes } from "@/platform/storage/upload-protocol";
import { documentObjectIdentitySchema,type DocumentObjectIdentity } from "./document-object";

// Versioned transport framing keeps each request below the hosting payload limit.
export const documentUploadChunkBytes=fieldUploadChunkBytes;
export const documentSingleBodyBytes=privateUploadSingleRequestBytes;
export const documentUploadPartsSchema=z.object({schemaVersion:z.literal(1),chunkBytes:z.literal(documentUploadChunkBytes),
  hashes:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(fieldUploadMaximumParts)}).strict();
export type DocumentUploadParts=z.infer<typeof documentUploadPartsSchema>;
export function documentPartContract(identity:DocumentObjectIdentity,index:number,raw:DocumentUploadParts){
  documentObjectIdentitySchema.parse(identity);
  const parts=documentUploadPartsSchema.parse(raw);z.number().int().min(0).max(parts.hashes.length-1).parse(index);
  if(parts.hashes.length!==Math.ceil(identity.fileSize/documentUploadChunkBytes))throw Error("invalid_document_part_manifest");
  const size=Math.min(documentUploadChunkBytes,identity.fileSize-index*documentUploadChunkBytes),sha256=parts.hashes[index];
  return{key:`organizations/${identity.organizationId}/documents/${identity.documentId}/admissions/${identity.admissionId}/parts/${index}.encrypted`,size,sha256,
    context:JSON.stringify(["document-upload-part-v1",identity.organizationId,identity.documentId,identity.admissionId,identity.contentType,identity.fileSize,identity.sha256,index,size,sha256])};
}
