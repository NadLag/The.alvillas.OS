import { z } from "zod";
import { fieldUploadChunkBytes, fieldUploadMaximumParts, privateUploadSingleRequestBytes } from "@/platform/storage/upload-protocol";

export const financialAttachmentMaximumBytes=50*1024*1024;
export const financialAttachmentUploadChunkBytes=4*fieldUploadChunkBytes;
export const financialAttachmentSingleBodyBytes=privateUploadSingleRequestBytes;
export const financialAttachmentUploadMaximumParts=fieldUploadMaximumParts;
export const financialAttachmentPartsSchema=z.object({schemaVersion:z.literal(1),chunkBytes:z.literal(financialAttachmentUploadChunkBytes),
  hashes:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(financialAttachmentUploadMaximumParts)}).strict();
export type FinancialAttachmentParts=z.infer<typeof financialAttachmentPartsSchema>;
export const financialAttachmentPartReferenceSchema=z.object({id:z.uuid().transform(value=>value.toLowerCase()),index:z.number().int().min(0).max(financialAttachmentUploadMaximumParts-1)}).strict();
const identitySchema=z.object({organizationId:z.uuid(),transactionId:z.uuid(),id:z.uuid(),contentType:z.string().min(1).max(40),
  fileSize:z.number().int().positive().max(financialAttachmentMaximumBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
type Identity=z.infer<typeof identitySchema>;
export function financialAttachmentPartContract(raw:Identity,index:number,manifest:FinancialAttachmentParts){
  const identity=identitySchema.parse(raw),parts=financialAttachmentPartsSchema.parse(manifest);
  financialAttachmentPartReferenceSchema.parse({id:identity.id,index});
  if(parts.hashes.length!==Math.ceil(identity.fileSize/financialAttachmentUploadChunkBytes)||index>=parts.hashes.length)throw Error("invalid_financial_attachment_part_manifest");
  const size=Math.min(financialAttachmentUploadChunkBytes,identity.fileSize-index*financialAttachmentUploadChunkBytes),sha256=parts.hashes[index];
  return{key:`organizations/${identity.organizationId}/financial-transactions/${identity.transactionId}/attachments/${identity.id}/parts/${index}.encrypted`,size,sha256,
    context:JSON.stringify(["financial-attachment-upload-part-v1",identity.organizationId,identity.transactionId,identity.id,identity.contentType,identity.fileSize,identity.sha256,parts.schemaVersion,parts.chunkBytes,index,size,sha256])};
}
