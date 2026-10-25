import { z } from "zod";
import { operationPolicySchema } from "@/platform/config/operation-policy";
import { evidenceInputSchema } from "./operation-task";
import { fieldUploadChunkBytes, fieldUploadMaximumParts, temporaryUploadPartKey } from "@/platform/storage/upload-protocol";

// Transport framing, independent of the property's configured evidence byte limit.
export { fieldUploadChunkBytes, fieldUploadMaximumParts } from "@/platform/storage/upload-protocol";
export const uploadDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const partSchema = z.object({ sha256: uploadDigestSchema, size: z.number().int().positive().max(fieldUploadChunkBytes) }).strict();

export const fieldUploadManifestSchema = z.object({
  protocolVersion: z.literal(1), localId: z.uuid().transform(value => value.toLowerCase()), taskId: z.uuid().transform(value => value.toLowerCase()),
  contentType: evidenceInputSchema.shape.contentType.unwrap(),
  note: evidenceInputSchema.shape.note,
  size: operationPolicySchema.shape.evidence_max_bytes,
  sha256: uploadDigestSchema,
  parts: z.array(partSchema).min(1).max(fieldUploadMaximumParts),
}).strict().superRefine((manifest, ctx) => {
  const expected = Math.ceil(manifest.size / fieldUploadChunkBytes);
  if (manifest.parts.length !== expected || manifest.parts.some((part, index) =>
    part.size !== Math.min(fieldUploadChunkBytes, manifest.size - index * fieldUploadChunkBytes))) {
    ctx.addIssue({ code: "custom", message: "upload_manifest_framing_invalid", path: ["parts"] });
  }
});
export type FieldUploadManifest = z.infer<typeof fieldUploadManifestSchema>;

export function fieldUploadPartStorageKey(organizationId: string, uploadId: string, index: number, generation = 1): string {
  return temporaryUploadPartKey({ organizationId, uploadId, index, generation });
}
